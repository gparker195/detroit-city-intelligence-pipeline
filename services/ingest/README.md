# services/ingest — the freshness proof

Standalone ingest package for Detroit City Intelligence. It reads City of Detroit ArcGIS
feature services through one adapter, writes immutable snapshots, diffs consecutive snapshots
into Change records, computes per-source health, and publishes a manifest that carries the
two dates every displayed fact must show: **City updated** (`layer_last_edit`) and
**we fetched** (`fetched_at`). See the product PRD, section "Freshness" (private monorepo), summarised in the root README.

The package is self-contained on purpose: its own `package.json`, `tsconfig.json` and
`node_modules`, so it can be lifted out into the public pipeline repository unchanged.

## Layout

```text
services/ingest/
  package.json, tsconfig.json         Node >= 24, TypeScript only (typescript + @types/node, both MIT)
  src/
    util/http.ts                      identifying User-Agent, 2 req/s ceiling, retry with backoff on 429/5xx
    arcgis/featureServiceClient.ts    layer metadata + paged /query (resultOffset, or OID chunks as fallback)
    registry/sources.ts               typed registry of 37 City feeds; item -> service URL resolved at runtime; per-source scope
    registry/studyAreas.ts            study areas = official polygons (v0: SNF "Livernois / McNichols", 300 m buffer)
    studyAreaRun.ts                   fetch:study-area: every source for one study area, then diff + health + manifest
    util/geo.ts                       point-in-polygon, polygon + buffer test, bbox helpers (no external dependency)
    snapshot/store.ts                 immutable snapshots under data/raw, sorted records, sha256, idempotent writes
    diff/engine.ts                    Change records between two snapshots; data/changes
    health/status.ts                  per-source health; data/health.json
    manifest/manifest.ts              data/manifest.json
    fetch.ts                          one source end to end: resolve -> metadata -> allowlist -> page -> snapshot
    cli/main.ts                       fetch | diff | health | manifest
  test/                               node:test, recorded fixtures only (no network)
    fixtures/                         real item, layer and query responses recorded 2026-09-21
    helpers/fakeArcgis.ts             fixture-backed fetch, fake clock
  data/                               generated; git-ignored except data/README.md (layout)
```

## Commands

Node 24 runs the TypeScript sources directly (built-in type stripping), so there is no build
step. `pnpm fetch` on its own is pnpm's store command, so always go through `pnpm run`:

```sh
export PATH="$HOME/Tools/node-v24.14.0-darwin-arm64/bin:$PATH"
cd services/ingest
pnpm install --ignore-workspace

pnpm run fetch <source_id> [--envelope minLon,minLat,maxLon,maxLat] [--where "<sql>"] [--force] [--no-envelope] [--no-skip]
pnpm run fetch:study-area [study_area_id] [--only a,b,c] [--force]
pnpm run diff <source_id>
pnpm run health
pnpm run manifest
pnpm test
pnpm typecheck
```

- Default envelope is the study area, `-83.1500,42.4100,-83.1330,42.4260` (about a 1.4 km box
  around Livernois and McNichols). Pass `--no-envelope` for a full-layer fetch.
- `DCI_DATA_DIR` overrides the data directory (default `services/ingest/data`).
- `fetch` prints one JSON object with row counts, both dates, and the sha256; a re-fetch of
  identical data reports `created: false` and writes nothing.
- `diff` compares the latest snapshot with the one before it and writes
  `data/changes/<source_id>/<snapshot_id>.ndjson`. With one snapshot it reports `no-previous`.
  Only fields in the current snapshot's `field_allowlist` take part: a field excluded after an
  older snapshot was taken never appears in a Change row (governance, not a data change).
- `fetch:study-area` fetches every registered source for a study area (default
  `livernois-mcnichols`): citywide sources first (SNF among them), then the study-area polygon is
  read from the SNF snapshot, polygon/line layers are fetched by polygon intersect (POST), point
  feeds by an attribute bbox on `longitude`/`latitude` followed by an exact point-in-(polygon +
  300 m buffer) test. One failing source does not stop the run. Then diff, health, manifest, and a
  per-source table on stderr plus a JSON report on stdout. Verified 2026-09-22: 37 sources in
  4 min 20 s at 2 req/s.

Source ids (37): `building-permits`, `dlba-for-sale`, `zoning`, `zoning-changes`, `snf`,
`parcels-current`, `business-licenses`, `liquor-licenses`, `blight-tickets`,
`vacant-property-registrations`, `certificate-of-occupancy`, `dev-opportunities-city-land`,
`election-precincts-2024`, `building-footprints`, `restaurant-inspections`, `dlba-owned`,
`dev-opportunities-city-buildings`, `dev-opportunities-dlba-buildings`, `master-plan-flu`, `nez-nr`,
`hrd-districts`, `nrsa-2020`, `gateway-radials`, `council-districts-2026`, `council-crosswalk`,
`ocp-agreements`, `business-certification-register`, `property-sales`, `improve-detroit-311`,
`rental-registrations`, `certificates-of-compliance-residential`,
`certificates-of-compliance-commercial`, `fire-incidents`, `row-permits` (layer 5),
`streetscape-projects` (layer 41), `city-parks`, `street-centerline`.

Each source has a `scope` for `fetch:study-area`: `polygon` (polygon/line layers intersecting the
study area), `buffer` (point feeds within polygon + 300 m) or `citywide` (small tables and district
layers fetched whole).

## How a fetch works

1. Resolve the ArcGIS item (`https://www.arcgis.com/sharing/rest/content/items/<id>?f=json`)
   and take the FeatureServer URL from it. Paths are never guessed; the registry's
   `expected_service` is only compared and logged if the item has moved.
2. Read layer metadata: fields, geometryType, maxRecordCount, `editingInfo.lastEditDate`,
   pagination support, object id field.
   **lastEditDate check:** when the latest snapshot has the same `layer_last_edit`, the same scope
   and the same `where`, and was complete, the fetch stops here (`skipped: "unchanged"`, two
   requests). `--force` or `--no-skip` bypasses it. Layers that publish no lastEditDate are always
   fetched and rely on the hash.
3. Compute the field allowlist against the live field list (plus `keep_only` for wide layers such
   as Building Footprints and 311) and choose the stable key.
4. Page `/query` with `resultOffset`/`resultRecordCount`, ordered by the object id, WGS84 in
   and out, geometry included, optional `where` and envelope filter. Layers without
   pagination fall back to `returnIdsOnly` plus `OID IN (...)` chunks.
5. Reject rows with no stable key, sort by key, write canonical NDJSON, hash it. If the hash
   equals `latest.json`, nothing is written.

Every request carries `User-Agent: DetroitCityIntelligence/0.1 (+https://github.com/gparker195/detroit-city-intelligence-pipeline)`,
request starts are spaced at least 500 ms apart, and 429/5xx responses (including ArcGIS
"200 with error 5xx" bodies) are retried with exponential backoff up to 5 attempts.

## Health

`data/health.json` reports two independent axes per source plus a derived badge:

| Axis | Values | Rule |
|---|---|---|
| freshness | fresh, stale, never | stale when the last success is older than cadence x 1.5 (36 h for daily) |
| completeness | complete, partial, empty, none | partial when paging did not finish, when rows were rejected, or when rows were received but none kept |
| status | unavailable, loading, partial, stale, degraded, nominal | precedence in that order; degraded = good snapshot exists but the most recent attempt failed |

A snapshot with zero valid rows out of a nonzero received count is `partial`, never `nominal`.

## Cadence (from the PRD, starting values)

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

Only the City ArcGIS feeds are implemented here. In the registry every ArcGIS feed is `daily`
except `election-precincts-2024` (`weekly`; the pre-election daily rule is not automated yet).
The "fetch only if lastEditDate changed" optimisation is implemented (see "How a fetch works");
the hash still guards against writing an identical snapshot when a layer's date moves without
its rows changing.

## Field-allowlist policy (place, not person)

Applied to the live field list before any row is written, per source in `src/registry/sources.ts`:

- Default for every source: drop any field starting with `property_owner_` or `inspector_`,
  and the exact fields `owner_name`, `taxpayer_address`, `taxpayer_city`, `taxpayer_state`,
  `taxpayer_zip_code`.
- `taxpayer_1` and `taxpayer_2` are kept: they are the owner of record as published on the
  parcel (PRD "Field mappings").
- `blight-tickets` and `vacant-property-registrations` restate their exclusions explicitly
  (`property_owner_*`, `inspector_name`; `owner_name`) because those feeds publish them.
- Milestone 1 feeds: `business-certification-register` drops `authorized_contact_*` and
  `business_phone_number`; `property-sales` drops `grantor` and `grantee`; `restaurant-inspections`
  drops `establishment_owner`; `nez-nr` drops `petitioner_developer`; `liquor-licenses` drops
  `account_name` (dba is kept); `rental-registrations` drops `owner_*`; `streetscape-projects`
  drops `contactinfo`; `improve-detroit-311` keeps only category, type, status, dates and location
  (`issue_url` is not kept).

Two live facts (2026-09-22) recorded in the registry notes: the City's large point layers
(blight, 311, sales) publish most rows with null geometry, so a spatial filter under-counts by
about 99 % and the buffer scope uses an attribute bbox instead; the Liquor Licenses feed
publishes `number` and `business_id` as null on every row, so `ObjectId` is its stable key.
- `meta.json` records `field_allowlist` (kept) and `fields_dropped` for every snapshot, so the
  governance test can be audited per run.

Every source also carries `attribution`, `lifecycle`, `terms_verified_on` (2026-09-21), the
verbatim City open-data AS-IS reference, and `disclaimer_text` (the zoning map disclaimer for
`zoning`, otherwise null) so the app can display them wherever those records appear.

## OSM is never ingested here

OpenStreetMap is a rendered basemap only. This package has no OSM source and must never get
one: merging OSM data into the evidence database would put the snapshots under ODbL
share-alike. If a future feed turns out to be OSM-derived, it does not enter this registry.

## The public pipeline repository

This package lives in the public pipeline repository
(https://github.com/gparker195/detroit-city-intelligence-pipeline), where GitHub Actions cron
runs it on the free public-repo quota (scheduled workflows are effectively disabled on private
Free-plan repos):

- Code is MIT. Snapshots are City public data the City permits redistributing. Documenters
  content and anything under a private contract is excluded.
- `.github/workflows/refresh.yml` runs `fetch:study-area` daily at 06:00 America/Detroit
  (diff, health and manifest included), then `scripts/publish.sh` assembles the artifact folder
  (latest snapshot per source, `changes/`, `health.json`, `manifest.json`) behind the
  person-field and Documenters guards and publishes it as the rolling `latest` release.
  The next run restores that release as its diff baseline (`scripts/restore.sh`).
- The client reads `manifest.json` on open and downloads only what changed since its last manifest.

No API keys are required anywhere in this package.
