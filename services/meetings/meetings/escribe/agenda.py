"""Deterministic parser for eScribe Meeting.aspx agenda and minutes HTML.

Markup observed 2026-09-21 on pub-detroitmi.escribemeetings.com (see SOURCES.md):

  <HEADER> ... class='AgendaHeaderTitle' ... class='AgendaMeetingTimeStart' ... </HEADER>
  <DIV class='AgendaItems'>
    <DIV class='AgendaItemContainer indent'>
      <DIV class='AgendaItem AgendaItem<N>'>
        [<DIV class='AgendaItemContentRow indent'><DIV class='AgendaItemHeader'>SECTION</DIV></DIV>]
        <DIV class='AgendaItemTitleRow'><H2|H3 ...>
          <DIV class='AgendaItemCounter'>7.1</DIV>
          ... <DIV class='AgendaItemTitle'><a href="javascript:SelectItem(N);">TITLE</a></DIV> ...
        </H2|H3>
        ... attachments: <a class='Link' href="filestream.ashx?DocumentId=NNN" data-original-title='file.pdf'>
        <DIV class='AgendaItemContentRow indent'><DIV class='AgendaItemDescription RichText'>agenda text</DIV></DIV>
        <DIV class='AgendaItemContentRow indent'><DIV class='AgendaItemMinutes RichText'>recorded action</DIV></DIV>
        (child items follow in document order, nested one level deeper)

No LLM, no heuristics beyond the regexes below. Attributes use single quotes in this markup.
"""

from __future__ import annotations

import html as htmllib
import re
from dataclasses import dataclass, field

_ITEM_START = re.compile(r"<DIV class='AgendaItem AgendaItem(\d+)'", re.I)
_COUNTER = re.compile(r"class='AgendaItemCounter'[^>]*>(.*?)</DIV>", re.I | re.S)
_TITLE = re.compile(r"class='AgendaItemTitle'[^>]*>\s*<a[^>]*>(.*?)</a>", re.I | re.S)
_HEADER = re.compile(r"class='AgendaItemHeader'[^>]*>(.*?)</DIV>", re.I | re.S)
_LEVEL = re.compile(r"<(H[1-6])\s+Id='AgendaItemAgendaItem\d+TitleHeader'", re.I)
_ATTACHMENT = re.compile(
    r"<a class='Link'[^>]*href=\"([^\"]*filestream\.ashx\?DocumentId=(\d+))\"[^>]*data-original-title='([^']*)'",
    re.I,
)
_RICH_START = re.compile(r"<DIV class='AgendaItem(Description|Minutes) RichText'\s*>", re.I)
_TAG = re.compile(r"<[^>]+>")
_BLOCK_TAG = re.compile(r"</?(p|div|br|li|tr|h[1-6])\b[^>]*>", re.I)
_MONTH_DATE = re.compile(
    r"(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})"
)
_FILE_NUMBER = re.compile(r"\b(20\d{2}-\d{3})\b(?!\d)")
_PUBLIC_COMMENT = re.compile(r"\bpublic comment", re.I)
_CANCELLED = re.compile(r"\bcancel+ed\b", re.I)

_MONTHS = {m: i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], 1)}


@dataclass
class ParsedItem:
    escribe_item_id: str  # the N in AgendaItemN (stable within a meeting)
    item_number: str | None  # "7.1"
    title: str
    level: int  # 2 for H2 (top level), 3 for H3 ...
    section: str | None
    parent_item_number: str | None
    description: str | None
    minutes_text: str | None
    attachments: list[dict] = field(default_factory=list)  # {title, url, document_id}
    file_number: str | None = None
    is_public_comment: bool = False


@dataclass
class ParsedMeeting:
    title: str | None
    date: str | None  # YYYY-MM-DD
    location: str | None
    cancelled_in_header: bool
    items: list[ParsedItem]


def strip_scripts(doc: str) -> str:
    return re.sub(r"<script.*?</script>|<style.*?</style>", "", doc, flags=re.S | re.I)


def to_text(fragment: str) -> str:
    """HTML fragment -> plain text, paragraph breaks kept as newlines, whitespace collapsed."""
    s = _BLOCK_TAG.sub("\n", fragment)
    s = _TAG.sub(" ", s)
    s = htmllib.unescape(s).replace("\xa0", " ")
    lines = [re.sub(r"[ \t\r\f\v]+", " ", ln).strip() for ln in s.split("\n")]
    out: list[str] = []
    for ln in lines:
        if ln:
            out.append(ln)
        elif out and out[-1] != "":
            out.append("")
    return "\n".join(out).strip()


def balanced_div(doc: str, open_end: int) -> str:
    """Return inner HTML of a DIV whose opening tag ends at `open_end` (index just past '>')."""
    depth = 1
    pos = open_end
    tag = re.compile(r"<(/?)div\b[^>]*>", re.I)
    while depth:
        m = tag.search(doc, pos)
        if not m:
            return doc[open_end:]
        depth += -1 if m.group(1) else 1
        pos = m.end()
        if depth == 0:
            return doc[open_end : m.start()]
    return doc[open_end:pos]


def _rich_blocks(chunk: str) -> dict[str, str | None]:
    found: dict[str, str | None] = {"Description": None, "Minutes": None}
    for m in _RICH_START.finditer(chunk):
        kind = m.group(1)
        if found[kind] is None:
            found[kind] = to_text(balanced_div(chunk, m.end())) or None
    return found


def parse_header(doc: str) -> tuple[str | None, str | None, str | None, bool]:
    m = re.search(r"<HEADER.*?</HEADER>", doc, re.S | re.I)
    if not m:
        return None, None, None, False
    header = m.group(0)
    title = None
    t = re.search(r"class='AgendaHeaderTitle'[^>]*>", header, re.I)
    if t:
        title = to_text(balanced_div(header, t.end())).split("\n")[0:3]
        title = " | ".join(x for x in title if x)
    date = None
    d = _MONTH_DATE.search(to_text(header))
    if d:
        date = f"{int(d.group(3)):04d}-{_MONTHS[d.group(1)]:02d}-{int(d.group(2)):02d}"
    location = None
    loc = re.search(r"class='AgendaMeetingLocation'[^>]*>", header, re.I)
    if loc:
        location = to_text(balanced_div(header, loc.end())) or None
    cancelled = bool(_CANCELLED.search(to_text(header)))
    return title, date, location, cancelled


def parse_meeting_html(doc: str) -> ParsedMeeting:
    doc = strip_scripts(doc)
    title, date, location, cancelled = parse_header(doc)
    starts = list(_ITEM_START.finditer(doc))
    items: list[ParsedItem] = []
    # parent tracking by level: level -> (item_number, title)
    ancestors: dict[int, tuple[str | None, str]] = {}
    # group headers print once and apply to following siblings: (parent number, level) -> header
    group_header: dict[tuple[str | None, int], str] = {}
    for idx, m in enumerate(starts):
        end = starts[idx + 1].start() if idx + 1 < len(starts) else len(doc)
        chunk = doc[m.start() : end]
        counter = _COUNTER.search(chunk)
        number = to_text(counter.group(1)) if counter else None
        number = number.rstrip(".") if number else None
        t = _TITLE.search(chunk)
        item_title = to_text(t.group(1)) if t else ""
        lvl = _LEVEL.search(chunk)
        level = int(lvl.group(1)[1]) if lvl else 2
        h = _HEADER.search(chunk)
        header_text = to_text(h.group(1)) if h else None
        rich = _rich_blocks(chunk)
        attachments: list[dict] = []
        seen: set[str] = set()
        for a in _ATTACHMENT.finditer(chunk):
            doc_id = a.group(2)
            if doc_id in seen:
                continue
            seen.add(doc_id)
            attachments.append(
                {"title": htmllib.unescape(a.group(3)), "url": f"/filestream.ashx?DocumentId={doc_id}", "document_id": doc_id}
            )
        # ancestors: anything at a shallower level that came before
        for k in [k for k in ancestors if k >= level]:
            del ancestors[k]
        parent = ancestors.get(level - 1) or (ancestors[max(ancestors)] if ancestors else None)
        group_key = (parent[0] if parent else None, level)
        if header_text:
            group_header[group_key] = header_text
        header_text = group_header.get(group_key)
        section_parts = [p for p in [parent[1] if parent else None, header_text] if p]
        text_for_number = " ".join(x for x in [item_title, rich["Description"] or ""] if x)
        fn = _FILE_NUMBER.search(text_for_number)
        items.append(
            ParsedItem(
                escribe_item_id=m.group(1),
                item_number=number or None,
                title=item_title,
                level=level,
                section=" / ".join(section_parts) or None,
                parent_item_number=parent[0] if parent else None,
                description=rich["Description"],
                minutes_text=rich["Minutes"],
                attachments=attachments,
                file_number=fn.group(1) if fn else None,
                is_public_comment=bool(_PUBLIC_COMMENT.search(item_title)),
            )
        )
        ancestors[level] = (number, item_title)
    return ParsedMeeting(title=title, date=date, location=location, cancelled_in_header=cancelled, items=items)
