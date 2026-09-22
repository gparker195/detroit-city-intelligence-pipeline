#!/usr/bin/env bash
# Restore the previous run's published state so the diff engine has a baseline
# ("what changed" needs the snapshot before this one) and the meetings/civic outputs
# accumulate instead of starting empty.
#
#   bash scripts/restore.sh <dci-public.tar.gz | extracted folder>
#
# Restores, into the service data folders (all git-ignored):
#   snapshots/<source>/...        -> services/ingest/data/raw/<source>/...
#   changes/<source>/*.ndjson     -> services/ingest/data/changes/<source>/
#   civic/meetings-*.ndjson       -> services/meetings/data/normalized/*.ndjson
#   civic/meetings-manifest.json  -> services/meetings/data/manifest.json
#   civic/civic-*.ndjson          -> services/civic/data/normalized/*.ndjson
#   civic/civic-manifest.json     -> services/civic/data/manifest.json
# Nothing else is restored: the basemap is handled by the workflow, health.json and
# manifest.json are recomputed by the ingest run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:?usage: restore.sh <tarball|folder>}"
INGEST="${DCI_DATA_DIR:-$ROOT/services/ingest/data}"
MEETINGS="$ROOT/services/meetings/data"
CIVIC="${DCI_CIVIC_DATA_DIR:-$ROOT/services/civic/data}"

if [ -f "$SRC" ]; then
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  tar -xzf "$SRC" -C "$TMP"
  SRC="$TMP"
  # the tarball may carry a single top-level folder
  if [ ! -d "$SRC/snapshots" ] && [ "$(find "$SRC" -mindepth 1 -maxdepth 1 -type d | wc -l)" = "1" ]; then
    SRC="$(find "$SRC" -mindepth 1 -maxdepth 1 -type d)"
  fi
fi

n=0
if [ -d "$SRC/snapshots" ]; then
  for src_dir in "$SRC"/snapshots/*/; do
    [ -d "$src_dir" ] || continue
    source="$(basename "$src_dir")"
    mkdir -p "$INGEST/raw/$source"
    cp -R "$src_dir"/. "$INGEST/raw/$source/"
    n=$((n + 1))
  done
fi
echo "restored latest snapshots for $n sources into $INGEST/raw"

if [ -d "$SRC/changes" ]; then
  mkdir -p "$INGEST/changes"
  cp -R "$SRC"/changes/. "$INGEST/changes/"
  echo "restored $(find "$INGEST/changes" -name '*.ndjson' | wc -l | tr -d ' ') change files"
fi

if [ -d "$SRC/civic" ]; then
  mkdir -p "$MEETINGS/normalized" "$CIVIC/normalized"
  for f in "$SRC"/civic/meetings-*.ndjson; do [ -f "$f" ] && cp "$f" "$MEETINGS/normalized/${f##*/meetings-}"; done
  [ -f "$SRC/civic/meetings-manifest.json" ] && cp "$SRC/civic/meetings-manifest.json" "$MEETINGS/manifest.json"
  for f in "$SRC"/civic/civic-*.ndjson; do [ -f "$f" ] && cp "$f" "$CIVIC/normalized/${f##*/civic-}"; done
  [ -f "$SRC/civic/civic-manifest.json" ] && cp "$SRC/civic/civic-manifest.json" "$CIVIC/manifest.json"
  echo "restored meetings and civic normalized outputs"
fi
