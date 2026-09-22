#!/usr/bin/env bash
# Build the keyless Detroit-metro basemap extract. See README.md.
# Usage: ./build.sh [--maxzoom N] [--build YYYYMMDD] [--skip-copy]
set -euo pipefail
cd "$(dirname "$0")"
# Node 24 is required (see the root package.json engines field).
if [ ! -d node_modules ] && [ ! -d ../../node_modules ]; then
  pnpm install --ignore-workspace
fi
exec node build.mjs "$@"
