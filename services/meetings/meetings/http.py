"""Polite HTTP client: identifying User-Agent, 1 request per 2 s per host, robots.txt,
and a Cloudflare circuit breaker (back off, never bypass).

Only the standard library is used so the client can be reasoned about line by line.
"""

from __future__ import annotations

import gzip
import json
import time
import urllib.error
import urllib.request
import urllib.robotparser
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import urlsplit

from . import config


class CloudflareChallenge(Exception):
    """The host answered with a Cloudflare challenge. The connector stops reading that host."""


class HostBackedOff(Exception):
    """A previous request on this host hit a challenge; no further requests are sent this run."""


class RobotsDisallowed(Exception):
    """robots.txt disallows this URL for our User-Agent."""


@dataclass
class Response:
    url: str
    status: int
    headers: dict[str, str]
    body: bytes
    fetched_at: str  # ISO-8601 UTC
    seconds: float

    @property
    def content_type(self) -> str:
        return self.headers.get("content-type", "")

    def text(self, encoding: str = "utf-8") -> str:
        return self.body.decode(encoding, errors="replace")

    def json(self):
        return json.loads(self.body.decode("utf-8"))


@dataclass
class RequestLogEntry:
    at: str
    method: str
    url: str
    status: int | None
    bytes: int
    seconds: float
    cloudflare_challenge: bool = False
    error: str | None = None
    note: str | None = None


def looks_like_cloudflare_challenge(status: int, headers: dict[str, str], body: bytes) -> bool:
    if headers.get("cf-mitigated", "").lower() == "challenge":
        return True
    if status in (403, 503) and "cloudflare" in headers.get("server", "").lower():
        head = body[:20000].lower()
        if b"just a moment" in head or b"challenges.cloudflare.com" in head or b"cf-chl" in head:
            return True
    return False


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass
class Fetcher:
    user_agent: str = config.USER_AGENT
    min_interval: float = config.MIN_SECONDS_BETWEEN_REQUESTS
    timeout: int = config.HTTP_TIMEOUT_SECONDS
    honor_robots: bool = True
    _last_request_at: dict[str, float] = field(default_factory=dict)
    _robots: dict[str, urllib.robotparser.RobotFileParser | None] = field(default_factory=dict)
    _backed_off_hosts: set[str] = field(default_factory=set)
    log: list[RequestLogEntry] = field(default_factory=list)
    challenge_seen: bool = False
    sleep = staticmethod(time.sleep)
    clock = staticmethod(time.monotonic)

    # -- public API -----------------------------------------------------------------------------

    def get(self, url: str, *, accept: str = "*/*") -> Response:
        return self._request("GET", url, headers={"Accept": accept})

    def post_json(self, url: str, payload: dict) -> Response:
        data = json.dumps(payload).encode("utf-8")
        return self._request(
            "POST",
            url,
            data=data,
            headers={"Content-Type": "application/json; charset=utf-8", "Accept": "application/json"},
        )

    def host_backed_off(self, url: str) -> bool:
        return urlsplit(url).netloc in self._backed_off_hosts

    # -- internals ------------------------------------------------------------------------------

    def _request(self, method: str, url: str, *, data: bytes | None = None, headers: dict | None = None) -> Response:
        host = urlsplit(url).netloc
        if host in self._backed_off_hosts:
            raise HostBackedOff(f"{host}: backed off after a Cloudflare challenge earlier this run")
        if self.honor_robots and not self._robots_allows(url):
            self.log.append(RequestLogEntry(now_iso(), method, url, None, 0, 0.0, note="robots.txt disallow"))
            raise RobotsDisallowed(url)

        self._throttle(host)
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("User-Agent", self.user_agent)
        req.add_header("Accept-Encoding", "gzip")
        for k, v in (headers or {}).items():
            req.add_header(k, v)

        started = self.clock()
        fetched_at = now_iso()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                status = resp.status
                hdrs = {k.lower(): v for k, v in resp.headers.items()}
                body = resp.read()
        except urllib.error.HTTPError as e:
            status = e.code
            hdrs = {k.lower(): v for k, v in e.headers.items()}
            body = e.read() if e.fp is not None else b""
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            elapsed = self.clock() - started
            self.log.append(RequestLogEntry(fetched_at, method, url, None, 0, round(elapsed, 3), error=str(e)))
            raise

        if hdrs.get("content-encoding", "").lower() == "gzip":
            try:
                body = gzip.decompress(body)
            except OSError:
                pass
        elapsed = self.clock() - started

        challenged = looks_like_cloudflare_challenge(status, hdrs, body)
        self.log.append(
            RequestLogEntry(fetched_at, method, url, status, len(body), round(elapsed, 3), cloudflare_challenge=challenged)
        )
        if challenged:
            self.challenge_seen = True
            self._backed_off_hosts.add(host)
            raise CloudflareChallenge(f"{host} answered {status} with a Cloudflare challenge for {url}; backing off")
        return Response(url, status, hdrs, body, fetched_at, round(elapsed, 3))

    def _throttle(self, host: str) -> None:
        last = self._last_request_at.get(host)
        now = self.clock()
        if last is not None:
            wait = self.min_interval - (now - last)
            if wait > 0:
                self.sleep(wait)
        self._last_request_at[host] = self.clock()

    def _robots_allows(self, url: str) -> bool:
        parts = urlsplit(url)
        host = parts.netloc
        if host not in self._robots:
            robots_url = f"{parts.scheme}://{host}/robots.txt"
            rp = urllib.robotparser.RobotFileParser()
            try:
                resp = self._request_raw_robots(robots_url)
                if resp is None:
                    self._robots[host] = None
                else:
                    rp.parse(resp.text().splitlines())
                    self._robots[host] = rp
            except CloudflareChallenge:
                raise
            except Exception:  # unreachable robots.txt: treat as allow-all, like browsers do
                self._robots[host] = None
        rp = self._robots.get(host)
        if rp is None:
            return True
        return rp.can_fetch(self.user_agent, url)

    def _request_raw_robots(self, robots_url: str) -> Response | None:
        # robots.txt itself is fetched without the robots check (would recurse) but with throttle + log.
        saved = self.honor_robots
        self.honor_robots = False
        try:
            resp = self._request("GET", robots_url, headers={"Accept": "text/plain"})
        finally:
            self.honor_robots = saved
        if resp.status >= 400:
            return None
        return resp
