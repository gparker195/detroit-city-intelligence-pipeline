"""eScribe fetch pipeline: discovered meeting -> raw archive -> Event / CouncilItem / Vote / Document.

Rules honoured here:
  * one request per 2 s, identifying UA (Fetcher)
  * a Cloudflare challenge on any URL stops all further requests to that host this run; the run
    records `fetch_blocked` for what it could not read and never retries in-run
  * public-comment items keep their minutes text in the raw archive only (governance: never
    indexed by speaker); the normalized item carries is_public_comment=true and no action text
  * lifecycle is a label over verbatim action text; an agenda item stays Scheduled until minutes
    record something
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin

from .. import config
from ..addresses import find_candidates
from ..archive import ArchiveEntry, RawArchive
from ..http import CloudflareChallenge, Fetcher, HostBackedOff
from ..lifecycle import classify, parse_tally, result_phrase
from ..pdftext import extract_pages
from ..records import Attachment, CouncilItem, Document, Event, Provenance, Vote
from .agenda import ParsedMeeting, parse_meeting_html
from .calendar import DiscoveredMeeting


@dataclass
class MeetingFetchResult:
    meeting: DiscoveredMeeting
    event: Event | None
    items: list[CouncilItem] = field(default_factory=list)
    votes: list[Vote] = field(default_factory=list)
    documents: list[Document] = field(default_factory=list)
    requests: list[dict] = field(default_factory=list)
    blocked: list[str] = field(default_factory=list)  # URLs not read because of a challenge/back-off
    new_bytes: int = 0


def _fetch_to_archive(fetcher: Fetcher, archive: RawArchive, key: str, kind: str, url: str, *, title=None, document_id=None) -> tuple[ArchiveEntry | None, dict]:
    try:
        resp = fetcher.get(url)
    except HostBackedOff as e:
        return None, {"url": url, "skipped": "host backed off", "detail": str(e)}
    except CloudflareChallenge as e:
        return None, {"url": url, "cloudflare_challenge": True, "detail": str(e)}
    except OSError as e:
        return None, {"url": url, "error": str(e)}
    if resp.status != 200:
        return None, {"url": url, "status": resp.status, "bytes": len(resp.body)}
    if kind.endswith("_pdf") and not resp.body.startswith(b"%PDF"):
        return None, {"url": url, "status": resp.status, "bytes": len(resp.body), "note": "not a PDF body"}
    entry, is_new = archive.put("escribe", key, kind, url, resp.body, resp.fetched_at, resp.content_type, title=title, document_id=document_id)
    return entry, {"url": url, "status": resp.status, "bytes": len(resp.body), "sha256": entry.sha256, "new": is_new}


def event_status(meeting: DiscoveredMeeting, agenda: ParsedMeeting | None, minutes: ParsedMeeting | None, now: datetime) -> tuple[str, str]:
    name_blob = (meeting.source_name or "") + " " + (agenda.title if agenda and agenda.title else "")
    if "cancel" in name_blob.lower() or (agenda and agenda.cancelled_in_header) or (minutes and minutes.cancelled_in_header):
        return "cancelled", "the word 'cancelled' appears in the meeting name or agenda header"
    if minutes is not None and minutes.items:
        return "held", "minutes (PostMinutes) published on eScribe"
    if meeting.start <= now.strftime("%Y-%m-%dT%H:%M:%S"):
        return "scheduled", "start time has passed but no minutes are published yet; held-ness not inferred"
    return "scheduled", "future meeting with a published agenda"


def build_records(
    meeting: DiscoveredMeeting,
    *,
    agenda: ParsedMeeting | None,
    minutes: ParsedMeeting | None,
    agenda_entry: ArchiveEntry | None,
    minutes_entry: ArchiveEntry | None,
    snapshot_id: str,
    observed_at: str,
    now: datetime,
) -> tuple[Event, list[CouncilItem], list[Vote], list[Document]]:
    status, basis = event_status(meeting, agenda, minutes, now)
    held = status == "held"
    event_id = f"escribe:{meeting.meeting_id}"
    raw_sha = (minutes_entry or agenda_entry).sha256 if (minutes_entry or agenda_entry) else None
    event = Event(
        event_id=event_id, body=meeting.body, name=meeting.source_name, date=meeting.date, start=meeting.start,
        status=status, status_basis=basis, location=meeting.location,
        agenda_url=meeting.agenda_html_url, minutes_url=meeting.minutes_html_url,
        agenda_pdf_url=meeting.agenda_pdf_url, minutes_pdf_url=meeting.minutes_pdf_url, video_url=meeting.video_url,
        provenance=Provenance(config.SOURCE_ESCRIBE, snapshot_id, observed_at, meeting.date, meeting.agenda_html_url, raw_sha),
    )
    docs: list[Document] = []
    for kind, entry, url in (("agenda_html", agenda_entry, meeting.agenda_html_url), ("minutes_html", minutes_entry, meeting.minutes_html_url)):
        if entry:
            docs.append(Document(
                document_id=f"escribe:{kind}:{meeting.meeting_id}", event_id=event_id, item_id=None, kind=kind,
                title=f"{meeting.source_name} {meeting.date} {kind.split('_')[0]}", url=url or entry.url, sha256=entry.sha256,
                bytes=entry.bytes, content_type=entry.content_type, fetched_at=entry.first_fetched_at,
                extraction_status="html", pages=[],
                provenance=Provenance(config.SOURCE_ESCRIBE, snapshot_id, observed_at, meeting.date, url, entry.sha256),
            ))

    # Minutes carry the same items as the agenda plus the recorded action; prefer minutes when present.
    primary = minutes if (minutes and minutes.items) else agenda
    agenda_by_number = {it.item_number: it for it in (agenda.items if agenda else [])}
    items: list[CouncilItem] = []
    votes: list[Vote] = []
    for it in (primary.items if primary else []):
        item_id = f"{event_id}:{it.escribe_item_id}"
        description = it.description or (agenda_by_number.get(it.item_number).description if it.item_number in agenda_by_number else None)
        action_text = it.minutes_text if primary is minutes else None
        if it.is_public_comment:
            lifecycle, basis = "Unknown", "public comment item; minutes text kept in raw archive only, not indexed by speaker (governance)"
            action_text, attachments, candidates = None, [], []
        else:
            lifecycle, basis = classify(action_text, meeting_held=held)
            attachments = [Attachment(a["title"], urljoin(config.ESCRIBE_BASE + "/", a["url"]), a["document_id"]) for a in it.attachments]
            candidates = find_candidates(" ".join(x for x in [it.title, description or "", action_text or ""] if x))
        src_url = meeting.minutes_html_url if primary is minutes else meeting.agenda_html_url
        items.append(CouncilItem(
            item_id=item_id, event_id=event_id, body=meeting.body, meeting_date=meeting.date,
            item_number=it.item_number, file_number=it.file_number, title=it.title, section=it.section,
            description=description, action_text=action_text, lifecycle=lifecycle, lifecycle_basis=basis,
            attachments=attachments, address_candidates=candidates, is_public_comment=it.is_public_comment,
            provenance=Provenance(config.SOURCE_ESCRIBE, snapshot_id, observed_at, meeting.date, src_url, raw_sha),
        ))
        tally = parse_tally(action_text)
        if action_text and tally is not None and not it.is_public_comment:
            votes.append(Vote(
                vote_id=f"{item_id}:vote", item_id=item_id, event_id=event_id, motion=action_text,
                result=result_phrase(action_text), tally=tally, roll_call=None,
                roll_call_basis="eScribe minutes publish the tally as text; no per-member roll call is published inline",
                provenance=Provenance(config.SOURCE_ESCRIBE, snapshot_id, observed_at, meeting.date, src_url, raw_sha),
            ))
    return event, items, votes, docs


def fetch_meeting(
    fetcher: Fetcher,
    archive: RawArchive,
    meeting: DiscoveredMeeting,
    *,
    snapshot_id: str,
    now: datetime,
    fetch_pdfs: bool = True,
    max_pdfs_per_meeting: int = 25,
) -> MeetingFetchResult:
    key = meeting.meeting_id
    result = MeetingFetchResult(meeting, None)
    agenda = minutes = None
    agenda_entry = minutes_entry = None

    if meeting.agenda_html_url:
        agenda_entry, log = _fetch_to_archive(fetcher, archive, key, "agenda_html", meeting.agenda_html_url)
        result.requests.append(log)
        if agenda_entry is None and (log.get("cloudflare_challenge") or log.get("skipped")):
            result.blocked.append(meeting.agenda_html_url)
        if agenda_entry:
            agenda = parse_meeting_html(archive.read_bytes(agenda_entry).decode("utf-8", "replace"))
            result.new_bytes += agenda_entry.bytes if log.get("new") else 0
    if meeting.minutes_html_url:
        minutes_entry, log = _fetch_to_archive(fetcher, archive, key, "minutes_html", meeting.minutes_html_url)
        result.requests.append(log)
        if minutes_entry is None and (log.get("cloudflare_challenge") or log.get("skipped")):
            result.blocked.append(meeting.minutes_html_url)
        if minutes_entry:
            minutes = parse_meeting_html(archive.read_bytes(minutes_entry).decode("utf-8", "replace"))
            result.new_bytes += minutes_entry.bytes if log.get("new") else 0

    observed_at = (minutes_entry or agenda_entry).last_fetched_at if (minutes_entry or agenda_entry) else meeting.calendar_fetched_at
    event, items, votes, docs = build_records(
        meeting, agenda=agenda, minutes=minutes, agenda_entry=agenda_entry, minutes_entry=minutes_entry,
        snapshot_id=snapshot_id, observed_at=observed_at, now=now,
    )
    result.event, result.items, result.votes, result.documents = event, items, votes, docs

    if fetch_pdfs:
        fetch_attachments(fetcher, archive, result, snapshot_id=snapshot_id, max_pdfs_per_meeting=max_pdfs_per_meeting)
    return result


def fetch_attachments(fetcher: Fetcher, archive: RawArchive, result: MeetingFetchResult, *, snapshot_id: str, max_pdfs_per_meeting: int = 25) -> None:
    """Second phase, run after every HTML page of the run is archived: attachment PDFs.

    filestream.ashx answered a Cloudflare challenge on 2026-09-21 while Meeting.aspx did not, so
    PDFs are always fetched last; the first challenge backs the host off for the rest of the run
    and every remaining attachment is recorded as fetch_blocked.
    """
    event, items, docs, meeting = result.event, result.items, result.documents, result.meeting
    if event is None:
        return
    key = meeting.meeting_id
    observed_at = event.provenance.observed_at
    seen: set[str] = set()
    n = 0
    for item in items:
        for att in item.attachments:
            if att.document_id in seen or n >= max_pdfs_per_meeting:
                continue
            seen.add(att.document_id)
            n += 1
            existing = next((e for e in archive.read_index("escribe", key) if e.kind == "attachment_pdf" and e.document_id == att.document_id), None)
            if existing is None:
                existing, log = _fetch_to_archive(fetcher, archive, key, "attachment_pdf", att.url, title=att.title, document_id=att.document_id)
                result.requests.append(log)
                if existing is None:
                    status = "fetch_blocked" if (log.get("cloudflare_challenge") or log.get("skipped")) else "fetch_failed"
                    if status == "fetch_blocked":
                        result.blocked.append(att.url)
                    docs.append(Document(
                        document_id=f"escribe:attachment:{att.document_id}", event_id=event.event_id, item_id=item.item_id,
                        kind="attachment_pdf", title=att.title, url=att.url, sha256=None, bytes=None, content_type=None,
                        fetched_at=None, extraction_status=status, pages=[],
                        provenance=Provenance(config.SOURCE_ESCRIBE, snapshot_id, observed_at, meeting.date, att.url, None),
                    ))
                    continue
            pages, status = extract_pages(archive.root / existing.path)
            docs.append(Document(
                document_id=f"escribe:attachment:{att.document_id}", event_id=event.event_id, item_id=item.item_id,
                kind="attachment_pdf", title=att.title, url=att.url, sha256=existing.sha256, bytes=existing.bytes,
                content_type=existing.content_type, fetched_at=existing.first_fetched_at, extraction_status=status, pages=pages,
                provenance=Provenance(config.SOURCE_ESCRIBE, snapshot_id, observed_at, meeting.date, att.url, existing.sha256),
            ))


def rebuild_from_archive(archive: RawArchive, meeting: DiscoveredMeeting, *, snapshot_id: str, now: datetime) -> MeetingFetchResult | None:
    """Offline: rebuild records for a meeting from what is already archived (no network)."""
    agenda_entry = archive.latest("escribe", meeting.meeting_id, "agenda_html")
    minutes_entry = archive.latest("escribe", meeting.meeting_id, "minutes_html")
    if not agenda_entry and not minutes_entry:
        return None
    agenda = parse_meeting_html(archive.read_bytes(agenda_entry).decode("utf-8", "replace")) if agenda_entry else None
    minutes = parse_meeting_html(archive.read_bytes(minutes_entry).decode("utf-8", "replace")) if minutes_entry else None
    observed_at = (minutes_entry or agenda_entry).last_fetched_at
    event, items, votes, docs = build_records(meeting, agenda=agenda, minutes=minutes, agenda_entry=agenda_entry,
                                              minutes_entry=minutes_entry, snapshot_id=snapshot_id, observed_at=observed_at, now=now)
    for e in archive.read_index("escribe", meeting.meeting_id):
        if e.kind == "attachment_pdf":
            pages, status = extract_pages(Path(archive.root) / e.path)
            docs.append(Document(
                document_id=f"escribe:attachment:{e.document_id}", event_id=event.event_id, item_id=None, kind="attachment_pdf",
                title=e.title, url=e.url, sha256=e.sha256, bytes=e.bytes, content_type=e.content_type, fetched_at=e.first_fetched_at,
                extraction_status=status, pages=pages,
                provenance=Provenance(config.SOURCE_ESCRIBE, snapshot_id, observed_at, meeting.date, e.url, e.sha256),
            ))
    r = MeetingFetchResult(meeting, event, items, votes, docs)
    return r
