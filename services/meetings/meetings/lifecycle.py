"""Map recorded action text (verbatim, from minutes) to the PRD lifecycle.

Deterministic, order-sensitive rules. The verbatim text always travels with the record; the
lifecycle is a label on top of it, never a replacement. Unmapped text stays "Unknown".
"""

from __future__ import annotations

import re

_RULES: list[tuple[str, re.Pattern[str]]] = [
    # Withdrawn / removed first: "Remove from agenda 9-0" must not read as Approved.
    ("Withdrawn", re.compile(r"\b(withdrawn|withdraw|removed? from (the )?agenda|struck from (the )?agenda)\b", re.I)),
    # Deferred / postponed / held / tabled
    ("Deferred", re.compile(r"\b(postpone[ds]?|defer(red)?|held in committee|hold in committee|laid on the table|tabled|table[ds]?\b(?! of)|continued to|carried over|brought back)\b", re.I)),
    # Denied
    ("Denied", re.compile(r"\b(denied|deny|fail(ed)?|rejected|defeated|not approved|disapproved)\b", re.I)),
    # Referred (committee referral is the Formal Session's most common action)
    ("Referred", re.compile(r"\b(refer(red)? (back )?to|referral to|re-?referred)\b", re.I)),
    # Approved / adopted / passed / confirmed
    ("Approved", re.compile(r"\b(approved?|adopt(ed)?|passed|confirmed|granted|accepted|concur(red)?|enacted|carried)\b", re.I)),
]


def classify(action_text: str | None, *, meeting_held: bool) -> tuple[str, str]:
    """Return (lifecycle, basis). `basis` says which rule fired so reviewers can audit it."""
    text = (action_text or "").strip()
    if not text:
        if meeting_held:
            return "Unknown", "meeting held; no action text recorded for this item"
        return "Scheduled", "agenda item; meeting not yet held"
    for label, pattern in _RULES:
        m = pattern.search(text)
        if m:
            return label, f"matched '{m.group(0)}' in recorded action text"
    return "Unknown", "recorded action text did not match any lifecycle rule"


_TALLY = re.compile(r"(?<!\d)(\d{1,2})\s*-\s*(\d{1,2})(?!\d)")


def parse_tally(action_text: str | None) -> dict[str, int] | None:
    """'Approved 9-0' -> {'yes': 9, 'no': 0}. Returns None when no tally is recorded."""
    if not action_text:
        return None
    m = _TALLY.search(action_text)
    if not m:
        return None
    return {"yes": int(m.group(1)), "no": int(m.group(2))}


def result_phrase(action_text: str) -> str:
    """The recorded result with the tally removed, e.g. 'REFER TO THE COMMITTEE'."""
    return re.sub(r"\s+", " ", _TALLY.sub("", action_text)).strip(" -–")
