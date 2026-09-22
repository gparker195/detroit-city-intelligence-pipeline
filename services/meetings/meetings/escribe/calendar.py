"""Meeting discovery on eScribe.

Verified 2026-09-21: the portal has no ICS/iCal export and no HTML list of meetings that a
plain GET returns; the calendar page fills itself with two JSON web methods. We call exactly
what the page's own JavaScript calls, at 1 request per 2 s, with the identifying User-Agent:

  POST https://pub-detroitmi.escribemeetings.com/MeetingsCalendarView.aspx/GetCalendarMeetings
  Content-Type: application/json; charset=utf-8
  {"calendarStartDate": "YYYY-MM-DDT00:00:00", "calendarEndDate": "YYYY-MM-DDT00:00:00"}
  -> {"d": [ {ID, MeetingName, StartDate "YYYY/MM/DD HH:MM:SS", MeetingType, MeetingPassed,
             HasAgenda, Location, MeetingDocumentLink: [{Type: Agenda|PostMinutes|Video, Url, Format}], ...} ]}

  POST .../MeetingsCalendarView.aspx/PastMeetings   {"type": "<MeetingType>", "pageNumber": 1}
  -> {"d": {"TotalCount": n, "Meetings": [ {Id, MeetingType, MeetingLinks: [...], ...} ]}}
  (used only when the calendar window fails; 50 per page)

One GetCalendarMeetings call is made per calendar month in the window.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from .. import config
from ..archive import RawArchive
from ..http import Fetcher, Response

_ESCRIBE_DATE = re.compile(r"^(\d{4})/(\d{2})/(\d{2}) (\d{2}):(\d{2}):(\d{2})$")


@dataclass
class DiscoveredMeeting:
    meeting_id: str
    source_name: str  # MeetingName as published
    body: str  # canonical (allowlisted) body
    start: str  # ISO local "YYYY-MM-DDTHH:MM:SS"
    date: str  # YYYY-MM-DD
    location: str | None
    meeting_passed: bool | None
    agenda_html_url: str | None
    agenda_pdf_url: str | None
    minutes_html_url: str | None
    minutes_pdf_url: str | None
    video_url: str | None
    calendar_sha256: str
    calendar_fetched_at: str
    raw: dict = field(default_factory=dict)


def parse_escribe_datetime(s: str) -> str | None:
    m = _ESCRIBE_DATE.match(s or "")
    if not m:
        return None
    y, mo, d, h, mi, se = m.groups()
    return f"{y}-{mo}-{d}T{h}:{mi}:{se}"


def month_windows(start: date, end: date) -> list[tuple[date, date]]:
    """Whole calendar months covering [start, end]. Matches how the page itself pages."""
    out = []
    cur = start.replace(day=1)
    while cur <= end:
        nxt = (cur.replace(day=28) + timedelta(days=4)).replace(day=1)
        out.append((cur, nxt))
        cur = nxt
    return out


def _links(meeting: dict) -> dict[str, str | None]:
    found: dict[str, str | None] = {"agenda_html": None, "agenda_pdf": None, "minutes_html": None, "minutes_pdf": None, "video": None}
    for link in meeting.get("MeetingDocumentLink") or meeting.get("MeetingLinks") or []:
        url = link.get("Url") or ""
        typ = (link.get("Type") or "").lower()
        fmt = (link.get("Format") or "").lower()
        if url.startswith("./"):
            url = url[1:]
        if url.startswith("/"):
            url = config.ESCRIBE_BASE + url
        if typ == "agenda":
            key = "agenda_pdf" if fmt == ".pdf" or "FileStream" in url or "filestream" in url else "agenda_html"
        elif typ == "postminutes":
            key = "minutes_pdf" if fmt == ".pdf" or "FileStream" in url or "filestream" in url else "minutes_html"
        elif typ == "video":
            key = "video"
        else:
            continue
        if found[key] is None:
            found[key] = url
    return found


def normalize_calendar_meeting(m: dict, *, sha256: str, fetched_at: str) -> DiscoveredMeeting | None:
    """Apply the body allowlist and flatten one calendar entry. Returns None if not allowlisted."""
    name = m.get("MeetingType") or m.get("MeetingName") or ""
    body = config.canonical_body(name)
    if body is None:
        return None
    start = parse_escribe_datetime(m.get("StartDate") or m.get("Start") or "")
    if not start:
        return None
    links = _links(m)
    return DiscoveredMeeting(
        meeting_id=(m.get("ID") or m.get("Id") or "").lower(),
        source_name=name,
        body=body,
        start=start,
        date=start[:10],
        location=(m.get("Location") or m.get("LocationName") or None),
        meeting_passed=m.get("MeetingPassed"),
        agenda_html_url=links["agenda_html"],
        agenda_pdf_url=links["agenda_pdf"],
        minutes_html_url=links["minutes_html"],
        minutes_pdf_url=links["minutes_pdf"],
        video_url=links["video"],
        calendar_sha256=sha256,
        calendar_fetched_at=fetched_at,
        raw=m,
    )


@dataclass
class DiscoveryResult:
    window_start: str
    window_end: str
    requests: list[dict]
    meetings: list[DiscoveredMeeting]
    excluded_names: dict[str, int]
    cloudflare_challenge: bool = False


def discover(
    fetcher: Fetcher,
    archive: RawArchive,
    *,
    start: date,
    end: date,
) -> DiscoveryResult:
    from ..archive import sha256_hex
    from ..http import CloudflareChallenge

    requests: list[dict] = []
    by_id: dict[str, DiscoveredMeeting] = {}
    excluded: dict[str, int] = {}
    challenged = False
    for ws, we in month_windows(start, end):
        payload = {"calendarStartDate": f"{ws.isoformat()}T00:00:00", "calendarEndDate": f"{we.isoformat()}T00:00:00"}
        try:
            resp: Response = fetcher.post_json(config.ESCRIBE_CALENDAR_METHOD, payload)
        except CloudflareChallenge as e:
            requests.append({"url": config.ESCRIBE_CALENDAR_METHOD, "payload": payload, "error": str(e)})
            challenged = True
            break
        requests.append({"url": config.ESCRIBE_CALENDAR_METHOD, "payload": payload, "status": resp.status, "bytes": len(resp.body)})
        if resp.status != 200:
            continue
        digest = sha256_hex(resp.body)
        archive.put("calendar", f"{ws.isoformat()}_{we.isoformat()}", "calendar_json", config.ESCRIBE_CALENDAR_METHOD,
                    resp.body, resp.fetched_at, resp.content_type)
        for m in resp.json().get("d", []):
            dm = normalize_calendar_meeting(m, sha256=digest, fetched_at=resp.fetched_at)
            if dm is None:
                nm = m.get("MeetingType") or m.get("MeetingName") or "?"
                excluded[nm] = excluded.get(nm, 0) + 1
                continue
            if not (start.isoformat() <= dm.date <= end.isoformat()):
                continue
            by_id[dm.meeting_id] = dm
    meetings = sorted(by_id.values(), key=lambda m: (m.start, m.body))
    return DiscoveryResult(start.isoformat(), end.isoformat(), requests, meetings, excluded, challenged)


def window(days_back: int, days_ahead: int, today: date | None = None) -> tuple[date, date]:
    today = today or datetime.now().date()
    return today - timedelta(days=days_back), today + timedelta(days=days_ahead)
