"""CLI: python -m meetings {discover,fetch,backfill,manifest} ...

  discover  [--back 60 --ahead 30]            list allowlisted meetings in the window (1 request per month)
  fetch     [--back 60 --ahead 30] [--no-pdfs] [--limit N]
                                              discover, archive agenda/minutes HTML (+PDFs), normalize
  backfill  --year 2016 [--limit 50] [--no-roll-calls]
                                              Legistar events for a year -> same records, source_id legistar
  manifest                                    rebuild data/manifest.json from data/normalized
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from . import config
from .archive import RawArchive
from .escribe.calendar import discover, window
from .escribe.pipeline import fetch_attachments, fetch_meeting
from .http import CloudflareChallenge, Fetcher
from .legistar import backfill
from .normalize import build_manifest, write_all


def _run_id(prefix: str) -> str:
    return f"{prefix}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"


def _write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1, ensure_ascii=False, default=str) + "\n", "utf-8")


def _save_request_log(fetcher: Fetcher, run_id: str, extra: dict | None = None) -> Path:
    p = config.DATA_DIR / "runs" / f"{run_id}.json"
    _write_json(p, {"run_id": run_id, "user_agent": fetcher.user_agent, "min_interval_seconds": fetcher.min_interval,
                    "cloudflare_challenge_seen": fetcher.challenge_seen, **(extra or {}), "requests": [asdict(e) for e in fetcher.log]})
    return p


def cmd_discover(args) -> int:
    fetcher, archive = Fetcher(), RawArchive()
    start, end = window(args.back, args.ahead)
    run_id = _run_id("discover")
    res = discover(fetcher, archive, start=start, end=end)
    per_body: dict[str, int] = {}
    for m in res.meetings:
        per_body[m.body] = per_body.get(m.body, 0) + 1
    out = {"run_id": run_id, "window": [res.window_start, res.window_end], "requests": res.requests,
           "cloudflare_challenge": res.cloudflare_challenge, "meetings_found": len(res.meetings), "per_body": per_body,
           "excluded_by_allowlist": res.excluded_names,
           "meetings": [{k: v for k, v in asdict(m).items() if k != "raw"} for m in res.meetings]}
    _write_json(config.DATA_DIR / "discovery" / f"{run_id}.json", out)
    _save_request_log(fetcher, run_id)
    print(json.dumps({k: v for k, v in out.items() if k != "meetings"}, indent=1))
    for m in res.meetings:
        print(f"{m.date} {m.start[11:16]}  {m.body:55s} {m.meeting_id}  agenda={'y' if m.agenda_html_url else '-'} minutes={'y' if m.minutes_html_url else '-'}")
    return 0


def cmd_fetch(args) -> int:
    fetcher, archive = Fetcher(), RawArchive()
    start, end = window(args.back, args.ahead)
    run_id = _run_id("fetch")
    now = datetime.now()
    res = discover(fetcher, archive, start=start, end=end)
    meetings = res.meetings[: args.limit] if args.limit else res.meetings
    records = {"events": [], "items": [], "votes": [], "documents": []}
    touched: set[str] = set()
    per_body: dict[str, int] = {}
    blocked: list[str] = []
    summary_meetings = []
    results = []
    # Phase 1: every agenda / minutes HTML page (Meeting.aspx). Phase 2: attachment PDFs (filestream.ashx),
    # last, because that path answered a Cloudflare challenge on 2026-09-21 and one challenge backs the host off.
    for m in meetings:
        per_body[m.body] = per_body.get(m.body, 0) + 1
        r = fetch_meeting(fetcher, archive, m, snapshot_id=run_id, now=now, fetch_pdfs=False)
        results.append(r)
        print(f"{m.date}  {m.body:55s} status={r.event.status if r.event else '?':9s} items={len(r.items):3d} votes={len(r.votes):3d} blocked={len(r.blocked)}", flush=True)
    if not args.no_pdfs:
        for r in results:
            fetch_attachments(fetcher, archive, r, snapshot_id=run_id)
            if fetcher.challenge_seen:
                print("Cloudflare challenge on an attachment URL; backing off this host for the rest of the run (no bypass, no retry).", file=sys.stderr, flush=True)
                break
    for r in results:
        m = r.meeting
        blocked.extend(r.blocked)
        if r.event:
            touched.add(r.event.event_id)
            records["events"].append(r.event.to_dict())
            records["items"].extend(i.to_dict() for i in r.items)
            records["votes"].extend(v.to_dict() for v in r.votes)
            records["documents"].extend(d.to_dict() for d in r.documents)
        summary_meetings.append({"meeting_id": m.meeting_id, "body": m.body, "date": m.date, "status": r.event.status if r.event else None,
                                 "items": len(r.items), "votes": len(r.votes), "documents": len(r.documents), "blocked": len(r.blocked)})
    counts = write_all(records, source_id=config.SOURCE_ESCRIBE, touched_event_ids=touched)
    summary = {"run_id": run_id, "source": "escribe", "window": [res.window_start, res.window_end], "discovery_requests": res.requests,
               "meetings_found": len(res.meetings), "meetings_fetched": len(meetings), "per_body": per_body,
               "excluded_by_allowlist": res.excluded_names, "cloudflare_challenge_seen": fetcher.challenge_seen,
               "urls_blocked": blocked, "requests_made": len(fetcher.log), "records_written": {k: len(v) for k, v in records.items()},
               "records_on_disk": counts, "meetings": summary_meetings}
    _write_json(config.DATA_DIR / "discovery" / f"{run_id}.json", summary)
    _save_request_log(fetcher, run_id)
    build_manifest(run_summary={k: v for k, v in summary.items() if k not in ("meetings", "discovery_requests")})
    print(json.dumps({k: v for k, v in summary.items() if k != "meetings"}, indent=1))
    return 0


def cmd_backfill(args) -> int:
    fetcher, archive = Fetcher(), RawArchive()
    run_id = _run_id(f"backfill-{args.year}")
    try:
        res = backfill(fetcher, archive, year=args.year, limit=args.limit, snapshot_id=run_id, fetch_roll_calls=not args.no_roll_calls)
    except CloudflareChallenge as e:
        print(f"stopped: {e}", file=sys.stderr)
        _save_request_log(fetcher, run_id)
        return 2
    records = {"events": [e.to_dict() for e in res.events], "items": [i.to_dict() for i in res.items],
               "votes": [v.to_dict() for v in res.votes], "documents": [d.to_dict() for d in res.documents]}
    touched = {e.event_id for e in res.events}
    counts = write_all(records, source_id=config.SOURCE_LEGISTAR, touched_event_ids=touched)
    summary = {"run_id": run_id, "source": "legistar", "year": args.year, "events_seen": res.events_seen, "events_kept": res.events_kept,
               "per_body": res.per_body, "requests_made": len(fetcher.log), "records_written": {k: len(v) for k, v in records.items()},
               "records_on_disk": counts}
    _save_request_log(fetcher, run_id, {"requests_summary": res.requests})
    build_manifest(run_summary=summary)
    print(json.dumps(summary, indent=1))
    return 0


def cmd_manifest(args) -> int:
    print(json.dumps(build_manifest(), indent=1))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="meetings", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("discover"); d.add_argument("--back", type=int, default=config.DEFAULT_DAYS_BACK); d.add_argument("--ahead", type=int, default=config.DEFAULT_DAYS_AHEAD); d.set_defaults(fn=cmd_discover)
    f = sub.add_parser("fetch"); f.add_argument("--back", type=int, default=config.DEFAULT_DAYS_BACK); f.add_argument("--ahead", type=int, default=config.DEFAULT_DAYS_AHEAD)
    f.add_argument("--no-pdfs", action="store_true"); f.add_argument("--limit", type=int, default=0); f.set_defaults(fn=cmd_fetch)
    b = sub.add_parser("backfill"); b.add_argument("--year", type=int, required=True); b.add_argument("--limit", type=int, default=config.LEGISTAR_EVENTS_PER_RUN); b.add_argument("--no-roll-calls", action="store_true"); b.set_defaults(fn=cmd_backfill)
    m = sub.add_parser("manifest"); m.set_defaults(fn=cmd_manifest)
    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
