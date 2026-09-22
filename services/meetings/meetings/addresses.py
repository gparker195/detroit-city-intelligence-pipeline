"""Regex-only address / parcel CANDIDATE extraction. Nothing here resolves a location.

Every hit is a candidate with location_confidence 'needs_review'. Resolution against the
City's base units happens elsewhere, never in this connector.
"""

from __future__ import annotations

import re

from .records import AddressCandidate

_SUFFIX = (
    r"(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Court|Ct|Place|Pl|Lane|Ln|Highway|Hwy|"
    r"Parkway|Pkwy|Trail|Trl|Way|Circle|Cir|Terrace|Ter|Freeway|Fwy|Expressway|Expy|Mile(?:\s+Road|\s+Rd)?)"
)
_DIRECTION = r"(?:[NESW]\.?\s+|North\s+|South\s+|East\s+|West\s+)?"

# 1234 W. Grand River Ave / 19160 Evergreen Road / 7 Mile Road / 1301 East Warren Avenue
STREET_ADDRESS = re.compile(
    r"\b(\d{1,6}(?:\s*[-–]\s*\d{1,6})?)\s+"
    + _DIRECTION
    + r"((?:[A-Z][A-Za-z0-9'’.\-]*|\d{1,2}(?:st|nd|rd|th)?)(?:\s+(?:[A-Z][A-Za-z0-9'’.\-]*|\d{1,2}(?:st|nd|rd|th)?)){0,4})\s+"
    + _SUFFIX
    + r"\b\.?",
)

# Streets that Detroit records name without a suffix (Woodward, Gratiot, Michigan, Jefferson ...).
_BARE_ARTERIALS = (
    "Woodward|Gratiot|Michigan|Jefferson|Grand River|Fort|Livernois|McNichols|Mack|Warren|Van Dyke|"
    "Conant|Mound|Dequindre|Schaefer|Greenfield|Evergreen|Telegraph|Wyoming|Joy|Plymouth|Fenkell|"
    "Puritan|Davison|Outer Drive|Vernor|Springwells|Dix|Bagley|Cass|Trumbull|Rosa Parks|Lodge|Chene"
)
BARE_ARTERIAL_ADDRESS = re.compile(r"\b(\d{3,6})\s+" + _DIRECTION + r"(" + _BARE_ARTERIALS + r")\b(?!\s+" + _SUFFIX + r")")

# Detroit parcel numbers: 8 digits then "." or "-" plus optional 1-3 digits, e.g. 16010838. / 22079766-8
PARCEL_ID = re.compile(r"(?<![\d.])(\d{8}(?:\.\d{0,3}|-\d{1,3}))(?![\d])")

# Legal descriptions in Council resolutions: "Ward 17 Item 000123"
WARD_ITEM = re.compile(r"\bWard\s+(\d{1,2})\s+Item\s+(\d{3,7})\b", re.I)

# Things that look like addresses but are not: phone numbers, dollar amounts, dates, percentages.
_NOISE = re.compile(r"\(\d{3}\)\s*\d{3}-\d{4}|\$\s?[\d,]+|\b\d{1,2}/\d{1,2}/\d{2,4}\b")


def find_candidates(text: str | None) -> list[AddressCandidate]:
    if not text:
        return []
    cleaned = _NOISE.sub(" ", text)
    seen: set[str] = set()
    out: list[AddressCandidate] = []

    def add(s: str, kind: str) -> None:
        key = re.sub(r"\s+", " ", s).strip(" .").lower()
        if key and key not in seen:
            seen.add(key)
            out.append(AddressCandidate(text=re.sub(r"\s+", " ", s).strip(), kind=kind))

    for m in STREET_ADDRESS.finditer(cleaned):
        add(m.group(0), "street_address")
    for m in BARE_ARTERIAL_ADDRESS.finditer(cleaned):
        add(m.group(0), "street_address")
    for m in PARCEL_ID.finditer(cleaned):
        add(m.group(1), "parcel_id")
    for m in WARD_ITEM.finditer(cleaned):
        add(m.group(0), "ward_item")
    return out
