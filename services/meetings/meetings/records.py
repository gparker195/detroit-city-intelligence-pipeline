"""Typed records shared by the eScribe and Legistar connectors.

Shapes follow docs/product/PRD.md, Journey 4. Every record carries:
  source_id, source_snapshot_id, observed_at (we fetched), effective_at (the City's date),
  limitations (verbatim sentence).

Lifecycle values: Scheduled | Referred | Approved | Deferred | Denied | Withdrawn | Unknown
Event status:     scheduled | held | cancelled
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from .config import LIMITATIONS

LIFECYCLES = ("Scheduled", "Referred", "Approved", "Deferred", "Denied", "Withdrawn", "Unknown")
EVENT_STATUSES = ("scheduled", "held", "cancelled")


@dataclass
class Provenance:
    source_id: str
    source_snapshot_id: str
    observed_at: str
    effective_at: str | None
    source_url: str | None = None
    raw_sha256: str | None = None
    limitations: list[str] = field(default_factory=lambda: list(LIMITATIONS))


@dataclass
class Attachment:
    title: str
    url: str
    document_id: str | None = None


@dataclass
class AddressCandidate:
    text: str
    kind: str  # "street_address" | "parcel_id" | "ward_item"
    location_confidence: str = "needs_review"


@dataclass
class Event:
    event_id: str
    body: str
    name: str
    date: str  # YYYY-MM-DD, local (America/Detroit) as published
    start: str | None  # ISO local datetime as published, no tz conversion
    status: str
    status_basis: str
    location: str | None
    agenda_url: str | None
    minutes_url: str | None
    agenda_pdf_url: str | None
    minutes_pdf_url: str | None
    video_url: str | None
    provenance: Provenance

    def to_dict(self) -> dict[str, Any]:
        return {"record_type": "Event", **_flatten(self)}


@dataclass
class CouncilItem:
    item_id: str
    event_id: str
    body: str
    meeting_date: str
    item_number: str | None
    file_number: str | None
    title: str
    section: str | None
    description: str | None  # agenda text verbatim
    action_text: str | None  # minutes text verbatim
    lifecycle: str
    lifecycle_basis: str
    attachments: list[Attachment]
    address_candidates: list[AddressCandidate]
    is_public_comment: bool
    provenance: Provenance

    def to_dict(self) -> dict[str, Any]:
        return {"record_type": "CouncilItem", **_flatten(self)}


@dataclass
class Vote:
    vote_id: str
    item_id: str
    event_id: str
    motion: str  # verbatim text the result was read from
    result: str  # as recorded, e.g. "Approved", "REFER TO THE COMMITTEE"
    tally: dict[str, int] | None  # {"yes": 9, "no": 0} when a "9-0" style tally is recorded
    roll_call: list[dict[str, str]] | None  # [{"member": ..., "vote": ...}] only when published
    roll_call_basis: str
    provenance: Provenance

    def to_dict(self) -> dict[str, Any]:
        return {"record_type": "Vote", **_flatten(self)}


@dataclass
class Document:
    document_id: str
    event_id: str
    item_id: str | None
    kind: str  # agenda_html | minutes_html | attachment_pdf | agenda_pdf | minutes_pdf | api_json
    title: str | None
    url: str
    sha256: str | None
    bytes: int | None
    content_type: str | None
    fetched_at: str | None
    extraction_status: str  # extracted | not_fetched | fetch_blocked | extraction_failed | html
    pages: list[dict[str, Any]]  # [{"page": 1, "text": "..."}]
    provenance: Provenance

    def to_dict(self) -> dict[str, Any]:
        return {"record_type": "Document", **_flatten(self)}


def _flatten(rec) -> dict[str, Any]:
    d = asdict(rec)
    prov = d.pop("provenance")
    d.update(prov)
    return d
