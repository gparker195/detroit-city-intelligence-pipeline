"""Static configuration for the meetings connector.

Everything here was verified live on 2026-09-21 (see SOURCES.md). No keys, no secrets.
"""

from __future__ import annotations

import re
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
SERVICE_DIR = PACKAGE_DIR.parent
DATA_DIR = SERVICE_DIR / "data"

USER_AGENT = "DetroitCityIntelligence/0.1 (+https://github.com/gparker195/detroit-city-intelligence-pipeline)"

# One request every 2 seconds per host, no bursts.
MIN_SECONDS_BETWEEN_REQUESTS = 2.0
HTTP_TIMEOUT_SECONDS = 60

ESCRIBE_BASE = "https://pub-detroitmi.escribemeetings.com"
ESCRIBE_CALENDAR_METHOD = f"{ESCRIBE_BASE}/MeetingsCalendarView.aspx/GetCalendarMeetings"
ESCRIBE_PAST_METHOD = f"{ESCRIBE_BASE}/MeetingsCalendarView.aspx/PastMeetings"

LEGISTAR_BASE = "https://webapi.legistar.com/v1/detroit"

SOURCE_ESCRIBE = "escribe"
SOURCE_LEGISTAR = "legistar"

# Every record carries this sentence verbatim (PRD, Journey 4).
LIMITATIONS = ["An agenda item is not an approval; an approval is not execution."]

DEFAULT_DAYS_BACK = 60
DEFAULT_DAYS_AHEAD = 30
LEGISTAR_EVENTS_PER_RUN = 50

# ---------------------------------------------------------------------------
# Body allowlist (PRD: Council sessions, standing committees, Committee of the
# Whole, budget hearings, CDBG; test/demo/training bodies excluded).
#
# eScribe names read from the portal's meeting-type list on 2026-09-21.
# Legistar names read from /v1/detroit/bodies on 2026-09-21 ("City Council" is
# the Formal Session body there; "Rules Committee" is the Rules Standing Committee).
# ---------------------------------------------------------------------------
BODY_ALLOWLIST: dict[str, str] = {
    # exact source name (case-insensitive)      -> canonical body name
    "city council formal session": "City Council Formal Session",
    "city council special session": "City Council Special Session",
    "committee of the whole": "Committee of the Whole",
    "city council budget hearings": "City Council Budget Hearings",
    "budget, finance and audit standing committee": "Budget, Finance and Audit Standing Committee",
    "internal operations standing committee": "Internal Operations Standing Committee",
    "neighborhood and community services standing committee": "Neighborhood and Community Services Standing Committee",
    "planning and economic development standing committee": "Planning and Economic Development Standing Committee",
    "public health and safety standing committee": "Public Health and Safety Standing Committee",
    "rules standing committee": "Rules Standing Committee",
    "community development block grant": "Community Development Block Grant",
    # Legistar (2012-2017) spellings
    "city council": "City Council Formal Session",
    "rules committee": "Rules Standing Committee",
    "budget, finance and audit/internal operations standing committee": "Budget, Finance and Audit Standing Committee",
    "planning and economic development/neighborhood and community services standing committee": "Planning and Economic Development Standing Committee",
}

# Anything matching these is never ingested, even if it slipped past the allowlist.
BODY_EXCLUDE_PATTERN = re.compile(
    r"\b(test|demo|training|mock|escribe team|escribe meeting type)\b", re.IGNORECASE
)

# Bodies seen on the portal that are deliberately NOT in the allowlist (documented, not ingested):
#   City Council Closed Session, City Council Executive Session, City Council Evening Community Meeting,
#   City Council New Business (Legistar).


def canonical_body(name: str | None) -> str | None:
    """Return the canonical body name if `name` is allowlisted, else None."""
    if not name:
        return None
    key = re.sub(r"\s+", " ", name).strip().lower()
    if BODY_EXCLUDE_PATTERN.search(key):
        return None
    return BODY_ALLOWLIST.get(key)
