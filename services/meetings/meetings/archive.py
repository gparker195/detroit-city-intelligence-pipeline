"""Immutable, content-addressed raw archive under data/raw.

Layout (see data/README.md):
  data/raw/<scope>/<key>/<sha256>.<ext>   the exact bytes, written once
  data/raw/<scope>/<key>/index.json       list of entries; identical bytes only bump last_fetched_at
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path

from . import config

EXT_BY_KIND = {
    "calendar_json": "json",
    "past_json": "json",
    "agenda_html": "html",
    "minutes_html": "html",
    "attachment_pdf": "pdf",
    "agenda_pdf": "pdf",
    "minutes_pdf": "pdf",
    "api_json": "json",
}


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass
class ArchiveEntry:
    kind: str
    url: str
    sha256: str
    bytes: int
    content_type: str | None
    first_fetched_at: str
    last_fetched_at: str
    path: str  # relative to the archive root
    title: str | None = None
    document_id: str | None = None


class RawArchive:
    def __init__(self, root: Path | None = None):
        self.root = Path(root) if root else config.DATA_DIR / "raw"

    def folder(self, scope: str, key: str) -> Path:
        return self.root / scope / key

    def read_index(self, scope: str, key: str) -> list[ArchiveEntry]:
        p = self.folder(scope, key) / "index.json"
        if not p.exists():
            return []
        return [ArchiveEntry(**e) for e in json.loads(p.read_text("utf-8"))]

    def _write_index(self, scope: str, key: str, entries: list[ArchiveEntry]) -> None:
        p = self.folder(scope, key) / "index.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps([asdict(e) for e in entries], indent=1, ensure_ascii=False) + "\n", "utf-8")

    def put(
        self,
        scope: str,
        key: str,
        kind: str,
        url: str,
        body: bytes,
        fetched_at: str,
        content_type: str | None = None,
        title: str | None = None,
        document_id: str | None = None,
    ) -> tuple[ArchiveEntry, bool]:
        """Store bytes. Returns (entry, is_new_bytes). Idempotent for identical content."""
        digest = sha256_hex(body)
        ext = EXT_BY_KIND.get(kind, "bin")
        folder = self.folder(scope, key)
        folder.mkdir(parents=True, exist_ok=True)
        rel = f"{scope}/{key}/{digest}.{ext}"
        target = self.root / rel
        entries = self.read_index(scope, key)
        for e in entries:
            if e.sha256 == digest and e.kind == kind:
                e.last_fetched_at = fetched_at
                self._write_index(scope, key, entries)
                return e, False
        if not target.exists():
            tmp = target.with_suffix(target.suffix + ".part")
            tmp.write_bytes(body)
            tmp.replace(target)
        entry = ArchiveEntry(
            kind=kind,
            url=url,
            sha256=digest,
            bytes=len(body),
            content_type=content_type,
            first_fetched_at=fetched_at,
            last_fetched_at=fetched_at,
            path=rel,
            title=title,
            document_id=document_id,
        )
        entries.append(entry)
        self._write_index(scope, key, entries)
        return entry, True

    def latest(self, scope: str, key: str, kind: str) -> ArchiveEntry | None:
        entries = [e for e in self.read_index(scope, key) if e.kind == kind]
        if not entries:
            return None
        return sorted(entries, key=lambda e: e.last_fetched_at)[-1]

    def read_bytes(self, entry: ArchiveEntry) -> bytes:
        return (self.root / entry.path).read_bytes()

    def keys(self, scope: str) -> list[str]:
        base = self.root / scope
        if not base.exists():
            return []
        return sorted(p.name for p in base.iterdir() if (p / "index.json").exists())
