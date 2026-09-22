# detroit-city-intelligence-pipeline

The public data-refresh pipeline for **Detroit City Intelligence**: it reads City of Detroit open data
and other public government sources at a respectful rate, writes immutable snapshots, diffs consecutive
snapshots into Change records, computes per-source health, and publishes a manifest that carries the
two dates every displayed fact must show: **City updated** (`layer_last_edit` / `effective_at` /
`verified_on`) and **we fetched** (`fetched_at` / `observed_at`). It also builds a keyless
Detroit-metro basemap. It runs on GitHub Actions cron on the free public-repo quota, daily at
06:00 America/Detroit, with no secrets and no API keys.

The Atlas app, design tokens, query API and product documents live in a private monorepo. This
repository is the "Freshness" half of the product: the part that keeps the data current when the
user's device is off.

Code is MIT (see `LICENSE`). Data published here is City of Detroit public data whose reuse the
City permits, plus records from the other public sources listed below. Documenters content and
anything read under a private contract are excluded.

## What the split is

| Public repo (MIT code + public data) | Stays private |
|---|---|
| Ingest, meetings, civic and city-api code | Atlas app, design tokens, UI, model gateway, product docs |
| City of Detroit ArcGIS snapshots (public data the City permits redistributing): parcels, footprints, permits, licences, blight, 311 (category/status/dates/location only), sales, fire, right-of-way, designations, precincts, changes NDJSON | Anything read under a private contract or paid licence (CPIX exports, user-saved leads, authorized listings) |
| Council agendas/minutes as published by the City Clerk (eScribe, Legistar): events, items, votes, document metadata; public-comment items carry no text | **Documenters** content and any other third-party meeting notes or transcripts |
| USAspending, Program Registry (authored), Motor City Match / Re-Store awardee layers, State Tax Commission certificate lists, the Elections knowledge pack | Personal Provider Mode data (user accounts, keys) |
| Built artifacts: `manifest.json`, `health.json`, `changes/`, `geojson/`, `civic/` | The SQLite database itself (rebuilt by anyone with `pnpm run load`) |
| `basemap/`: the keyless Detroit-metro PMTiles extract with style, fonts, sprites and `ATTRIBUTION.txt` (OSM ODbL, Protomaps; rendered basemap only, rebuilt Sundays by `tools/basemap/build.sh`) | |

One adjustment to that table as it stands today: the city-api (the SQLite query database and its
GeoJSON layer cache) stayed in the private monorepo, so this repository publishes the **latest raw
snapshot per source** (`snapshots/`) instead of `geojson/`, and there is no `load-report.json`.

## Disclaimer and attribution

Every City open-data record carries this verbatim reference, and it must be displayed wherever
those records appear:

> Provided AS-IS by the City of Detroit Open Data Portal; no warranty as to accuracy, timeliness, or completeness.

Zoning records additionally carry the City's zoning map disclaimer verbatim
(`ZONING_MAP_DISCLAIMER` in `services/ingest/src/registry/sources.ts`).

Attribution that travels with the data:

- City of Detroit Open Data Portal (ArcGIS feature services): buildings, permits, licences, blight,
  311, sales, fire, right-of-way, zoning, master plan, districts, precincts, parks, centerlines.
- Detroit Land Bank Authority via the City of Detroit Open Data Portal (DLBA owned / for sale).
- Michigan Liquor Control Commission / LARA via the City of Detroit (liquor licences).
- Detroit City Clerk: eScribe portal (current record) and Legistar Web API (2012-2017 archive).
- USAspending.gov (federal awards with a Detroit place of performance).
- Michigan State Tax Commission certificate lists (michigan.gov, Treasury).
- Detroit Department of Elections (detroitvotes.org), Michigan Secretary of State, Wayne County.
- Detroit Economic Growth Corporation program pages; the City's Motor City Match and Re-Store awardee layers.
- Basemap: © OpenStreetMap contributors (ODbL 1.0), Protomaps (tiles CC0, code BSD-3-Clause),
  Noto Sans (SIL OFL 1.1), tangrams/icons sprites (MIT). See `THIRD-PARTY-NOTICES.md`.

## OpenStreetMap never enters the evidence database

OpenStreetMap is a **rendered basemap only**. `tools/basemap` produces a Produced Work
(`detroit-metro.pmtiles` plus style, glyphs and sprites) that is published with its attribution.
No package in this repository has an OSM source and none may get one: merging OSM data into the
snapshots, change rows or civic records would put them under ODbL share-alike. If a future feed
turns out to be OSM-derived, it does not enter the ingest registry.

## Cadence per source

Starting values from the product PRD ("Freshness"), tuned from observed `lastEditDate` behaviour:

| Source | Check | Why |
|---|---|---|
| City ArcGIS feeds (permits, DLBA, demolitions, licenses, blight, 311, precincts, all layers) | daily at 06:00 ET; read `editingInfo.lastEditDate` first, fetch only if changed | City edits daily; cheap HEAD-style check |
| eScribe agendas/minutes | daily, plus Monday and Tuesday mornings before Council sessions | agendas post days before meetings |
| Bonfire open opportunities (public page) | daily | close dates matter |
| USAspending (Detroit place of performance) | weekly | federal data lags |
| State Tax Commission certificate PDFs | monthly (their meeting cycle) | |
| Wayne County auction and forfeiture lists | weekly Jul-Nov, monthly otherwise | seasonal |
| Elections pages and precinct layers | weekly, daily in the 45 days before an election | |
| Programs (DEGC etc.) | weekly | windows open/close |
| Open Data Portal Change Log | weekly | deprecation detection |
| Terms/provider pages in the registry | before each release | terms drift |

Implemented in this repository today: the City ArcGIS feeds (daily; `election-precincts-2024`
weekly), eScribe (daily), Bonfire (daily; a link-out while its robots.txt disallows), USAspending
(Mondays), State Tax Commission (the 1st of the month), Programs and Elections (daily runs of
authored packs plus their live checks). Wayne County lists and the Open Data Portal Change Log are
not yet automated.

## What the workflow does, daily at 06:00 America/Detroit

`.github/workflows/refresh.yml` (two UTC crons, 10:00 and 11:00, gated to 06:00 local; also
`workflow_dispatch` with `force` and `basemap` inputs):

```text
restore previous release   → scripts/restore.sh: latest snapshot per source, changes/, civic outputs (the diff baseline)
ingest fetch:study-area    → City ArcGIS feeds for the study area; layers with an unchanged lastEditDate are skipped; diff, health, manifest
meetings fetch             → eScribe current record (Legistar archive is a one-time backfill)
civic connectors           → programs, elections daily; bonfire (link-out while robots.txt disallows); usaspending Mondays; stc on the 1st
basemap assets + style     → glyphs and sprites (cached), style.detroit-dark.json regenerated
basemap extract            → Sundays / on request / first run: tools/basemap/build.sh extracts Detroit metro from the Protomaps daily planet build; other days reuse the previous release asset
scripts/publish.sh         → dist/public: manifest.json, health.json, snapshots/, changes/, civic/, basemap/, index.json (behind the guards)
git commit + push          → only tools/basemap/detroit-metro.meta.json and style.detroit-dark.json (basemap provenance)
release "latest"           → dci-public.tar.gz + manifest.json, health.json, index.json, detroit-metro.pmtiles, meta, style, ATTRIBUTION.txt; the client reads one URL
```

`scripts/publish.sh` refuses to build the artifact folder if it finds Documenters content or any
person-level field (owner, inspector, contact, phone, grantor/grantee, licensee account name).
Snapshots and change rows are republished through each source's latest field allowlist, so a
governance decision applies retroactively to what leaves this repository.

Release assets (rolling tag `latest`): https://github.com/gparker195/detroit-city-intelligence-pipeline/releases/tag/latest

## Layout

```text
.github/workflows/refresh.yml   the daily workflow
scripts/publish.sh              assemble dist/public behind the guards
scripts/restore.sh              restore the previous release as the diff baseline
services/ingest                 TypeScript (Node 24, no build step): City ArcGIS ingest, snapshots, diff engine, health, manifest
services/civic                  TypeScript: USAspending, Bonfire, Program Registry, State Tax Commission, Elections pack
services/meetings               Python 3.12+ (stdlib + pdfplumber): eScribe + Legistar council records
tools/basemap                   Node: keyless Protomaps/OSM extract, style generator, glyph/sprite fetcher, tests
THIRD-PARTY-NOTICES.md          licenses and attribution for every dependency and data source
```

Each package README documents its commands, access rules and output shapes. Every `data/` folder
is generated and git-ignored (only `data/README.md`, the layout note, is tracked); the published
release is the durable copy.

## Local run

```sh
# Node 24 and pnpm 9.15.4 (packageManager field); Python 3.12+
pnpm install
pnpm -r build              # typechecks the TypeScript packages (Node 24 runs the sources directly)
pnpm -r test               # offline tests, recorded fixtures only
python3 -m venv services/meetings/.venv && services/meetings/.venv/bin/pip install -r services/meetings/requirements.txt
pnpm run test:meetings

cd services/ingest   && pnpm run fetch:study-area
cd ../meetings       && .venv/bin/python -m meetings fetch --back 60 --ahead 30
cd ../civic          && pnpm run programs && pnpm run elections && pnpm run manifest
cd ../../tools/basemap && node fetch-assets.mjs && node style.mjs && ./build.sh
cd ../..             && bash scripts/publish.sh dist/public
```

## Rules that travel with the code

- Identifying User-Agent (`DetroitCityIntelligence/0.1 (+https://github.com/gparker195/detroit-city-intelligence-pipeline)`),
  one request per 500 ms (ArcGIS) or 2 s (web), robots.txt honoured, no bot-challenge bypass, no logins,
  no MLS/LoopNet/CoStar/Crexi or other paid sources.
- Every record carries `source_id`, the City's own date (`layer_last_edit` / `effective_at` / `verified_on`)
  and our `fetched_at` / `observed_at`.
- Place, not person: the field allowlists in `services/ingest/src/registry/sources.ts` and the guard in
  `scripts/publish.sh` are part of the published code, so anyone can audit what is dropped. Public comment
  is never indexed by speaker; the meetings raw archive is never published.
- A source is not a conclusion: `changes/` is produced only by the diff engine; lifecycle labels sit next
  to verbatim action text; an agenda item is not an approval, an approval is not execution.
- OpenStreetMap data never enters the evidence records (ODbL share-alike).
- No recommendations, no valuations, no person-level roll-ups, no keys.
