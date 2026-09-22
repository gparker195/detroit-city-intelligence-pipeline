"""Legistar Web API backfill (2012-2017) for Detroit. No key. Verified 2026-09-21.

  GET https://webapi.legistar.com/v1/detroit/events?$filter=year(EventDate) eq 2016&$orderby=EventDate&$top=50
  GET https://webapi.legistar.com/v1/detroit/events/{EventId}/eventitems?AgendaNote=1&MinutesNote=1&Attachments=1
  GET https://webapi.legistar.com/v1/detroit/eventitems/{EventItemId}/votes     (only for items with a roll-call flag)
  GET https://webapi.legistar.com/v1/detroit/matters/{MatterId}                 (optional; file number already on the item)

Responses are archived under data/raw/legistar/<year>/<event_id>/ and normalized into the same
Event / CouncilItem / Vote / Document records as eScribe, with source_id 'legistar'.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from urllib.parse import quote

from . import config
from .addresses import find_candidates
from .archive import RawArchive, sha256_hex
from .http import Fetcher
from .lifecycle import classify, parse_tally, result_phrase
from .records import Attachment, CouncilItem, Document, Event, Provenance, Vote

_HELD_MINUTES_STATES = {"final", "approved", "published", "draft"}


@dataclass
class BackfillResult:
    year: int
    events_seen: int
    events_kept: int
    per_body: dict[str, int]
    events: list[Event]
    items: list[CouncilItem]
    votes: list[Vote]
    documents: list[Document]
    requests: list[dict] = field(default_factory=list)


def _event_status(ev: dict) -> tuple[str, str]:
    blob = " ".join(str(ev.get(k) or "") for k in ("EventComment", "EventAgendaStatusName", "EventMinutesStatusName", "EventBodyName"))
    if "cancel" in blob.lower():
        return "cancelled", "the word 'cancel' appears in the Legistar event record"
    if ev.get("EventMinutesFile") or (ev.get("EventMinutesStatusName") or "").lower() in _HELD_MINUTES_STATES:
        return "held", f"Legistar minutes status '{ev.get('EventMinutesStatusName')}'"
    return "scheduled", "no minutes recorded in Legistar; held-ness not inferred from the date"


def normalize_event(ev: dict, *, snapshot_id: str, observed_at: str, raw_sha: str) -> Event | None:
    body = config.canonical_body(ev.get("EventBodyName"))
    if body is None:
        return None
    status, basis = _event_status(ev)
    d = (ev.get("EventDate") or "")[:10]
    t = ev.get("EventTime") or ""
    start = f"{d}T{t}" if t else d
    eid = f"legistar:{ev['EventId']}"
    return Event(
        event_id=eid,
        body=body,
        name=ev.get("EventBodyName") or body,
        date=d,
        start=start,
        status=status,
        status_basis=basis,
        location=ev.get("EventLocation"),
        agenda_url=ev.get("EventInSiteURL"),
        minutes_url=None,
        agenda_pdf_url=ev.get("EventAgendaFile"),
        minutes_pdf_url=ev.get("EventMinutesFile"),
        video_url=ev.get("EventVideoPath"),
        provenance=Provenance(config.SOURCE_LEGISTAR, snapshot_id, observed_at, d,
                              f"{config.LEGISTAR_BASE}/events/{ev['EventId']}", raw_sha),
    )


def normalize_items(event: Event, items_json: list[dict], *, snapshot_id: str, observed_at: str, raw_sha: str) -> tuple[list[CouncilItem], list[Vote], list[Document]]:
    held = event.status == "held"
    items: list[CouncilItem] = []
    votes: list[Vote] = []
    docs: list[Document] = []
    for it in sorted(items_json, key=lambda x: (x.get("EventItemAgendaSequence") or 0, x.get("EventItemId") or 0)):
        item_id = f"legistar:{event.event_id.split(':')[1]}:{it['EventItemId']}"
        action_text = " ".join(x for x in [it.get("EventItemActionName"), it.get("EventItemActionText"), it.get("EventItemMinutesNote")] if x).strip() or None
        if it.get("EventItemPassedFlagName") and it.get("EventItemPassedFlagName") not in (action_text or ""):
            action_text = f"{action_text or ''} [{it['EventItemPassedFlagName']}]".strip()
        lifecycle, basis = classify(action_text, meeting_held=held)
        if not action_text and it.get("EventItemMatterStatus"):
            # Detroit's Legistar publishes no per-event action text (verified 2026-09-21: ActionName/ActionText/
            # MinutesNote/PassedFlag/Tally all null); the matter's status as published is recorded, not inferred from.
            basis = f"{basis}; Legistar MatterStatus as published: '{it['EventItemMatterStatus']}' (not used for lifecycle)"
        attachments = [Attachment(a.get("MatterAttachmentName") or "", a.get("MatterAttachmentHyperlink") or "", str(a.get("MatterAttachmentId") or ""))
                       for a in it.get("EventItemMatterAttachments") or []]
        title = (it.get("EventItemTitle") or "").strip()
        is_pc = "public comment" in title.lower()
        text_for_addresses = None if is_pc else " ".join(x for x in [title, it.get("EventItemAgendaNote") or ""] if x)
        items.append(CouncilItem(
            item_id=item_id, event_id=event.event_id, body=event.body, meeting_date=event.date,
            item_number=(it.get("EventItemAgendaNumber") or "").strip() or None,
            file_number=it.get("EventItemMatterFile"), title=title,
            section=it.get("EventItemMatterType"), description=it.get("EventItemAgendaNote"),
            action_text=None if is_pc else action_text, lifecycle=lifecycle if not is_pc else "Unknown",
            lifecycle_basis=basis if not is_pc else "public comment item; not indexed by speaker (governance)",
            attachments=[] if is_pc else attachments, address_candidates=find_candidates(text_for_addresses),
            is_public_comment=is_pc,
            provenance=Provenance(config.SOURCE_LEGISTAR, snapshot_id, observed_at, event.date,
                                  f"{config.LEGISTAR_BASE}/events/{event.event_id.split(':')[1]}/eventitems", raw_sha),
        ))
        if action_text and not is_pc and (it.get("EventItemPassedFlag") is not None or it.get("EventItemTally")):
            votes.append(Vote(
                vote_id=f"{item_id}:vote", item_id=item_id, event_id=event.event_id, motion=action_text,
                result=it.get("EventItemPassedFlagName") or result_phrase(action_text),
                tally=parse_tally(it.get("EventItemTally") or action_text), roll_call=None,
                roll_call_basis="roll call fetched separately via /eventitems/{id}/votes when EventItemRollCallFlag=1",
                provenance=Provenance(config.SOURCE_LEGISTAR, snapshot_id, observed_at, event.date, None, raw_sha),
            ))
        for a in attachments if not is_pc else []:
            docs.append(Document(
                document_id=f"legistar:attachment:{a.document_id}", event_id=event.event_id, item_id=item_id,
                kind="attachment_pdf", title=a.title, url=a.url, sha256=None, bytes=None, content_type=None,
                fetched_at=None, extraction_status="not_fetched", pages=[],
                provenance=Provenance(config.SOURCE_LEGISTAR, snapshot_id, observed_at, event.date, a.url, None),
            ))
    return items, votes, docs


def attach_roll_call(vote: Vote, votes_json: list[dict]) -> None:
    rc = [{"member": v.get("VotePersonName") or "", "vote": v.get("VoteValueName") or ""} for v in votes_json]
    if rc:
        vote.roll_call = rc
        vote.roll_call_basis = "as recorded in Legistar /eventitems/{id}/votes"


def backfill(fetcher: Fetcher, archive: RawArchive, *, year: int, limit: int = config.LEGISTAR_EVENTS_PER_RUN,
             snapshot_id: str, fetch_roll_calls: bool = True) -> BackfillResult:
    flt = quote(f"year(EventDate) eq {year}", safe="() ")
    url = f"{config.LEGISTAR_BASE}/events?$filter={flt}&$orderby=EventDate&$top={limit}".replace(" ", "%20")
    resp = fetcher.get(url, accept="application/json")
    reqs = [{"url": url, "status": resp.status, "bytes": len(resp.body)}]
    result = BackfillResult(year, 0, 0, {}, [], [], [], [], reqs)
    if resp.status != 200:
        return result
    events_json = resp.json()
    result.events_seen = len(events_json)
    for ev in events_json:
        key = f"{year}/{ev['EventId']}"
        entry, _ = archive.put("legistar", key, "api_json", f"{config.LEGISTAR_BASE}/events/{ev['EventId']}",
                               json.dumps(ev, sort_keys=True).encode("utf-8"), resp.fetched_at, "application/json")
        event = normalize_event(ev, snapshot_id=snapshot_id, observed_at=resp.fetched_at, raw_sha=entry.sha256)
        if event is None:
            continue
        result.events_kept += 1
        result.per_body[event.body] = result.per_body.get(event.body, 0) + 1
        result.events.append(event)
        items_url = f"{config.LEGISTAR_BASE}/events/{ev['EventId']}/eventitems?AgendaNote=1&MinutesNote=1&Attachments=1"
        r2 = fetcher.get(items_url, accept="application/json")
        reqs.append({"url": items_url, "status": r2.status, "bytes": len(r2.body)})
        if r2.status != 200:
            continue
        e2, _ = archive.put("legistar", key, "api_json", items_url, r2.body, r2.fetched_at, r2.content_type)
        items_json = r2.json()
        items, votes, docs = normalize_items(event, items_json, snapshot_id=snapshot_id, observed_at=r2.fetched_at, raw_sha=e2.sha256)
        if fetch_roll_calls:
            roll_items = {str(it["EventItemId"]) for it in items_json if it.get("EventItemRollCallFlag")}
            for v in votes:
                eiid = v.item_id.split(":")[-1]
                if eiid in roll_items:
                    vurl = f"{config.LEGISTAR_BASE}/eventitems/{eiid}/votes"
                    r3 = fetcher.get(vurl, accept="application/json")
                    reqs.append({"url": vurl, "status": r3.status, "bytes": len(r3.body)})
                    if r3.status == 200:
                        archive.put("legistar", key, "api_json", vurl, r3.body, r3.fetched_at, r3.content_type)
                        attach_roll_call(v, r3.json())
        result.items.extend(items)
        result.votes.extend(votes)
        result.documents.extend(docs)
        result.documents.append(Document(
            document_id=f"legistar:eventitems:{ev['EventId']}", event_id=event.event_id, item_id=None, kind="api_json",
            title="eventitems", url=items_url, sha256=e2.sha256, bytes=e2.bytes, content_type=e2.content_type,
            fetched_at=e2.first_fetched_at, extraction_status="json", pages=[],
            provenance=Provenance(config.SOURCE_LEGISTAR, snapshot_id, r2.fetched_at, event.date, items_url, e2.sha256),
        ))
    return result
