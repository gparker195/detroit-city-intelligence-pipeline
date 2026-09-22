"""NDJSON output and manifest.

data/normalized/{events,items,votes,documents}.ndjson are regenerated in full on every run from
the records of that run merged with the records already on disk (keyed by record id). Existing
records from the same source are replaced when the run touched that event; other sources and
untouched events are kept. Lines are sorted so diffs stay readable.

data/manifest.json carries the two dates the product must show for every fact:
  source_updated_at   the City's own date (latest effective_at seen per source)
  fetched_at          when we read it (latest observed_at per source)
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from . import config

FILES = {"events": "event_id", "items": "item_id", "votes": "vote_id", "documents": "document_id"}


def normalized_dir(root: Path | None = None) -> Path:
    return (root or config.DATA_DIR) / "normalized"


def read_ndjson(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text("utf-8").splitlines():
        if line.strip():
            out.append(json.loads(line))
    return out


def write_ndjson(path: Path, rows: list[dict], key: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = sorted(rows, key=lambda r: (r.get("effective_at") or "", r[key]))
    tmp = path.with_suffix(".ndjson.part")
    with tmp.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n")
    tmp.replace(path)


def merge_records(existing: list[dict], fresh: list[dict], key: str, touched_event_ids: set[str], source_id: str) -> list[dict]:
    kept = [r for r in existing if not (r.get("source_id") == source_id and r.get("event_id") in touched_event_ids)]
    by_key = {r[key]: r for r in kept}
    for r in fresh:
        by_key[r[key]] = r
    return list(by_key.values())


def write_all(records: dict[str, list[dict]], *, source_id: str, touched_event_ids: set[str], root: Path | None = None) -> dict[str, int]:
    nd = normalized_dir(root)
    counts = {}
    for name, key in FILES.items():
        path = nd / f"{name}.ndjson"
        merged = merge_records(read_ndjson(path), records.get(name, []), key, touched_event_ids, source_id)
        write_ndjson(path, merged, key)
        counts[name] = len(merged)
    return counts


def build_manifest(root: Path | None = None, *, run_summary: dict | None = None) -> dict:
    nd = normalized_dir(root)
    manifest_path = (root or config.DATA_DIR) / "manifest.json"
    previous = json.loads(manifest_path.read_text("utf-8")) if manifest_path.exists() else {}
    sources: dict[str, dict] = {}
    counts: dict[str, int] = {}
    for name in FILES:
        rows = read_ndjson(nd / f"{name}.ndjson")
        counts[name] = len(rows)
        for r in rows:
            s = sources.setdefault(r["source_id"], {"source_updated_at": None, "fetched_at": None, "records": {}})
            s["records"][name] = s["records"].get(name, 0) + 1
            eff, obs = r.get("effective_at"), r.get("observed_at")
            if eff and (s["source_updated_at"] is None or eff > s["source_updated_at"]):
                s["source_updated_at"] = eff
            if obs and (s["fetched_at"] is None or obs > s["fetched_at"]):
                s["fetched_at"] = obs
    runs = previous.get("runs", [])
    if run_summary:
        runs = (runs + [run_summary])[-50:]
    manifest = {
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "service": "services/meetings",
        "sources": {
            "escribe": {"url": config.ESCRIBE_BASE, "role": "current record", **sources.get("escribe", {"source_updated_at": None, "fetched_at": None, "records": {}})},
            "legistar": {"url": config.LEGISTAR_BASE, "role": "archive 2012-2017", **sources.get("legistar", {"source_updated_at": None, "fetched_at": None, "records": {}})},
        },
        "records": counts,
        "limitations": config.LIMITATIONS,
        "governance": [
            "Public comment is attached to the item and meeting; speaker text stays in the raw archive and is never indexed by speaker.",
            "Address and parcel mentions are candidates only (location_confidence 'needs_review'); nothing here resolves a location.",
        ],
        "runs": runs,
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n", "utf-8")
    return manifest
