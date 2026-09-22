#!/usr/bin/env bash
# Assemble the static artifact folder this public pipeline publishes (PRD "Freshness":
# "publish compact artifacts ... a manifest with per-source health and dates").
#
#   bash scripts/publish.sh [out_dir]      default: dist/public
#
# Contents (all public data; nothing under private contract, no Documenters content):
#   manifest.json                     ingest manifest (both dates per source) + build info
#   health.json                       per-source health axes
#   snapshots/<source>/latest.json    pointer to the latest immutable snapshot of that City feed
#   snapshots/<source>/<id>/          records.ndjson (allowlisted attributes + geometry) and meta.json
#   changes/<source>/*.ndjson         diff-engine Change rows (the only source of "what changed")
#   civic/*.ndjson                    meetings (events, items, votes, documents) and civic connector outputs
#   basemap/                          keyless Detroit-metro basemap: detroit-metro.pmtiles (+ .meta.json), style,
#                                     fonts, sprites, ATTRIBUTION.txt (OSM ODbL as a rendered basemap only)
#   index.json                        file list, byte sizes, build time, the City AS-IS disclaimer
#
# There is no query database here (that is the private city-api); the next run restores the
# snapshots from the published tarball (scripts/restore.sh) so the diff engine keeps its baseline.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist/public}"
INGEST="${DCI_DATA_DIR:-$ROOT/services/ingest/data}"
BASEMAP="${DCI_BASEMAP_DIR:-$ROOT/tools/basemap/public/basemap}"
MEETINGS="$ROOT/services/meetings/data"
CIVIC="${DCI_CIVIC_DATA_DIR:-$ROOT/services/civic/data}"

rm -rf "$OUT"
mkdir -p "$OUT/snapshots" "$OUT/changes" "$OUT/civic" "$OUT/basemap"

[ -f "$INGEST/manifest.json" ] || { echo "no $INGEST/manifest.json; run services/ingest pnpm run fetch:study-area first" >&2; exit 1; }
cp "$INGEST/manifest.json" "$OUT/manifest.json"
cp "$INGEST/health.json" "$OUT/health.json"

# Snapshots and change rows are republished through each source's LATEST field allowlist, so a
# governance decision (a field excluded after a snapshot was taken) applies retroactively to
# what leaves this repository. Only the latest snapshot per source is published; history lives
# in the release assets of earlier runs and in changes/.
python3 - "$INGEST" "$OUT" <<'PY'
import json, os, shutil, sys
ingest, out = sys.argv[1], sys.argv[2]
raw = os.path.join(ingest, 'raw')
def allowlist(source):
    try:
        latest = json.load(open(os.path.join(raw, source, 'latest.json')))
        meta = json.load(open(os.path.join(raw, source, latest['snapshot_id'], 'meta.json')))
        return latest, meta, set(meta.get('field_allowlist') or [])
    except FileNotFoundError:
        return None, None, None
def scrub(v, allowed):
    if isinstance(v, dict) and 'attributes' in v and isinstance(v['attributes'], dict):
        return {**v, 'attributes': {k: x for k, x in v['attributes'].items() if k in allowed}}
    return v

snap_sources = 0
if os.path.isdir(raw):
    for source in sorted(os.listdir(raw)):
        latest, meta, allowed = allowlist(source)
        if latest is None:
            continue
        sid = latest['snapshot_id']
        dst = os.path.join(out, 'snapshots', source, sid)
        os.makedirs(dst, exist_ok=True)
        shutil.copyfile(os.path.join(raw, source, sid, 'meta.json'), os.path.join(dst, 'meta.json'))
        with open(os.path.join(raw, source, sid, 'records.ndjson')) as src, open(os.path.join(dst, 'records.ndjson'), 'w') as f:
            for line in src:
                if not line.strip(): continue
                f.write(json.dumps(scrub(json.loads(line), allowed), sort_keys=True, separators=(',', ':')) + '\n')
        shutil.copyfile(os.path.join(raw, source, 'latest.json'), os.path.join(out, 'snapshots', source, 'latest.json'))
        snap_sources += 1
print(f"snapshots: latest snapshot republished for {snap_sources} sources")

total = kept = 0
changes = os.path.join(ingest, 'changes')
if os.path.isdir(changes):
    for source in sorted(os.listdir(changes)):
        src_dir = os.path.join(changes, source)
        if not os.path.isdir(src_dir): continue
        _, _, allowed = allowlist(source)
        os.makedirs(os.path.join(out, 'changes', source), exist_ok=True)
        for name in sorted(os.listdir(src_dir)):
            if not name.endswith('.ndjson'): continue
            rows = []
            for line in open(os.path.join(src_dir, name)):
                if not line.strip(): continue
                total += 1
                c = json.loads(line)
                if allowed is not None:
                    if c.get('field') not in (None, 'geometry') and c['field'] not in allowed: continue
                    c['old'] = scrub(c.get('old'), allowed); c['new'] = scrub(c.get('new'), allowed)
                rows.append(c); kept += 1
            with open(os.path.join(out, 'changes', source, name), 'w') as f:
                f.write(''.join(json.dumps(r, sort_keys=True) + '\n' for r in rows))
print(f"changes: {kept} of {total} rows republished through the latest allowlists")
PY

# Meetings: normalized records and manifest only. The raw archive (agenda/minutes HTML, PDFs)
# stays local: public-comment minutes text exists only there and is never published.
for f in "$MEETINGS"/normalized/*.ndjson; do [ -f "$f" ] && cp "$f" "$OUT/civic/meetings-$(basename "$f")"; done
[ -f "$MEETINGS/manifest.json" ] && cp "$MEETINGS/manifest.json" "$OUT/civic/meetings-manifest.json"
for f in "$CIVIC"/normalized/*.ndjson; do [ -f "$f" ] && cp "$f" "$OUT/civic/civic-$(basename "$f")"; done
[ -f "$CIVIC/manifest.json" ] && cp "$CIVIC/manifest.json" "$OUT/civic/civic-manifest.json"

# Basemap: a rendered basemap, published with its attribution; never merged into the evidence data.
if [ -f "$BASEMAP/detroit-metro.pmtiles" ]; then
  cp "$BASEMAP/detroit-metro.pmtiles" "$OUT/basemap/"
  [ -f "$BASEMAP/detroit-metro.meta.json" ] && cp "$BASEMAP/detroit-metro.meta.json" "$OUT/basemap/"
  [ -f "$BASEMAP/style.detroit-dark.json" ] && cp "$BASEMAP/style.detroit-dark.json" "$OUT/basemap/"
  [ -d "$BASEMAP/fonts" ] && cp -R "$BASEMAP/fonts" "$OUT/basemap/fonts"
  [ -d "$BASEMAP/sprites" ] && cp -R "$BASEMAP/sprites" "$OUT/basemap/sprites"
  BUILD_DATE="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('buildDate','unknown'))" "$BASEMAP/detroit-metro.meta.json" 2>/dev/null || echo unknown)"
  cat > "$OUT/basemap/ATTRIBUTION.txt" <<ATTR
Detroit-metro basemap extract (detroit-metro.pmtiles), Protomaps daily planet build $BUILD_DATE.
Map data (c) OpenStreetMap contributors, Open Database License (ODbL) 1.0, https://www.openstreetmap.org/copyright
Tiles: Protomaps basemap (tiles CC0; tileset code BSD-3-Clause), https://protomaps.com
Fonts: Noto Sans, SIL Open Font License 1.1. Sprites: Protomaps basemaps v4 (tangrams/icons, MIT).
This is a rendered basemap only. OSM data is never merged into the evidence database (share-alike boundary).
Serve detroit-metro.pmtiles with HTTP Range support.
ATTR
else
  echo "warning: no basemap at $BASEMAP; run tools/basemap/build.sh (or download the previous release asset)" >&2
fi

# Exclusion guard: nothing from a private contract or Documenters may leave this pipeline.
if grep -rIl --include='*.ndjson' --include='*.json' -i 'documenters' "$OUT" --exclude-dir=basemap >/dev/null 2>&1; then
  echo "refusing to publish: Documenters content found in the artifact folder" >&2; exit 2
fi

# Person-field guard: the same denylist the ingest allowlists enforce, applied to every record that leaves.
if grep -rIl --include='*.ndjson' --include='*.geojson' --exclude-dir=basemap -E '"(property_owner_[a-z_]+|inspector_name|owner_name|authorized_contact_[a-z_]+|business_phone_number|grantor|grantee|establishment_owner|petitioner_developer|account_name)"' "$OUT" >/dev/null 2>&1; then
  echo "refusing to publish: person-level field found in the artifact folder" >&2; exit 3
fi

BUILT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 - "$OUT" "$BUILT" <<'EOF'
import json, os, sys
out, built = sys.argv[1], sys.argv[2]
index = {"built_at": built, "files": []}
for root, _, files in os.walk(out):
    for f in sorted(files):
        p = os.path.join(root, f)
        index["files"].append({"path": os.path.relpath(p, out), "bytes": os.path.getsize(p)})
index["disclaimer"] = "Provided AS-IS by the City of Detroit Open Data Portal; no warranty as to accuracy, timeliness, or completeness. Every record carries a City-updated date and a fetched date."
index["basemap_notice"] = "basemap/ is a rendered OpenStreetMap basemap (ODbL, (c) OpenStreetMap contributors) and is never merged into the evidence records."
index["repository"] = "https://github.com/gparker195/detroit-city-intelligence-pipeline"
json.dump(index, open(os.path.join(out, "index.json"), "w"), indent=1)
print(f"{len(index['files'])} files, {sum(x['bytes'] for x in index['files'])/1e6:.1f} MB -> {out}")
EOF
