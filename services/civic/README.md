# services/civic — civic connectors (public money, tax-break certificates, voting)

Five connectors that read public government sources at a respectful rate, keep an immutable raw
archive, and emit NDJSON records the `city-api` can ingest. Covers PRD Journey 6 (public money,
A2 contract pathway, B program registry), Journey 7 (State Tax Commission certificate lists) and
Journey 10 (Elections knowledge pack). See the product PRD (private monorepo), sections "Journey 6", "A2",
"Journey 7", "Journey 10", "Freshness"; the cadences are summarised in the root README.

Self-contained on purpose: own `package.json`, `tsconfig.json`, `node_modules`. Node 24 runs the
TypeScript sources directly; there is no build step. Dependencies are all permissive:
`playwright` (Apache-2.0), `pdfjs-dist` (Apache-2.0), `typescript` and `@types/node` (MIT).

```text
services/civic/
  src/util/http.ts          identifying User-Agent, 1 request / 2 s floor, robots.txt evaluation (RFC 9309), bot-challenge stop
  src/util/browser.ts       Playwright session for hosts that only serve browsers (michigan.gov); same UA, robots read via the browser
  src/util/archive.ts       raw archive (sha256, fetched_at, source_updated), normalized NDJSON, manifest.json
  src/usaspending/          client.ts (POST spending_by_award, paging) · normalize.ts (Agreement) · cli.ts
  src/bonfire/              fetch.ts (robots first, then JSON-or-DOM capture) · normalize.ts (Solicitation) · cli.ts
  src/programs/             registry.json (governed Program Registry) · schema.ts (validator) · awardees.ts (two City layers) · cli.ts
  src/stc/                  fetch.ts (discover 2026 certificate PDFs) · pdfText.ts (pdf.js) · parse.ts (Designation) · cli.ts
  src/elections/            pack.json (rules + link-outs, dated and cited) · normalize.ts (rule/site/link records, site-page parser) · cli.ts
  test/                     node:test, offline, fixtures recorded 2026-09-21 (test/fixtures/README.md)
  data/                     generated, git-ignored except data/README.md
```

## Commands

```sh
export PATH="$HOME/Tools/node-v24.14.0-darwin-arm64/bin:$PATH"
cd services/civic
pnpm install                              # from the repository root (pnpm workspace)
npx playwright install chromium          # once; needed by bonfire and stc

pnpm run usaspending [--cap 500] [--fy 2026,2025] [--group contracts|grants]
pnpm run bonfire                          # exits non-zero and writes status "blocked" when robots.txt disallows
pnpm run programs [--no-awardees]
pnpm run stc [--year 2026] | --from-file <pdf> --program OPRA|IFT|CRA --url <official url>
pnpm run elections
pnpm run manifest                         # print data/manifest.json
pnpm test
pnpm typecheck
```

Every CLI prints one JSON report to stdout (counts, dates, examples) and the request log to stderr.
`DCI_CIVIC_DATA_DIR` overrides the data directory.

## Cadences (PRD "Freshness")

| Connector | Cadence | Why |
|---|---|---|
| usaspending | weekly | federal data lags |
| bonfire | daily | close dates matter (currently blocked by robots.txt; see below) |
| programs | weekly | windows open and close; awardee layers re-read for vintage |
| stc | monthly | State Tax Commission meeting cycle |
| elections | weekly; daily in the 45 days before an election (`cadenceFor()` reports which applies) | |

## Access rules and what happened on 2026-09-21

- Every request carries `User-Agent: DetroitCityIntelligence/0.1 (+https://github.com/gparker195/detroit-city-intelligence-pipeline)`
  and request starts are at least 2 s apart; a robots.txt `Crawl-delay` above that raises the interval
  (detroitvotes.org asks for 10 s and gets it).
- robots.txt is evaluated before any page read. A disallow stops the run (`RobotsDisallowedError`).
  A 4xx robots.txt imposes no rules (RFC 9309), but the page request itself is still subject to denial detection.
- Any interstitial bot challenge (Cloudflare "Just a moment", "Performing security verification") or an
  HTTP 403/429/503 stops the run (`BotChallengeError`). Nothing retries around it, nothing spoofs a
  browser fingerprint, nothing logs in.
- **Bonfire** (`detroit.bonfirehub.com`): robots.txt is `User-agent: * / Disallow: /`. The connector stops
  before loading the page, archives the robots.txt, and writes `status: "blocked"`. The normalizer is
  tested against a fixture so the connector is ready the day the City records terms or Bonfire publishes
  an export. Until then Bonfire is a link-out (PRD A2).
- **michigan.gov** (Treasury and SOS) returns 403 to plain HTTP clients but serves a Chromium with our UA.
  The `stc` connector therefore reads through Playwright, checks the robots.txt the browser is served,
  and downloads PDFs with an in-page `fetch` from the already-loaded Treasury page.
- **detroitmi.gov** and **michiganbusiness.org** served Cloudflare challenges to both the HTTP client and
  the browser session. Not bypassed. The programs registry and elections pack say so per record
  (`verification_note`, `notice.department_of_elections_page`) and use the alternative official pages
  (degc.org, detroitvotes.org, michigan.gov/sos, the City's ArcGIS register description).

## Governance notes

- Evidence first: every record carries `source_id`, `observed_at` (we fetched), the source's own date
  where it publishes one (`source_updated` in the manifest and raw `.meta.json`; `verified_on` on authored
  records; `vintage.layer_last_edit` on awardee points), and a `limitations` array with the fixed sentence
  the PRD prescribes for that record type.
- A source is not a conclusion: an Agreement is money obligated, a Solicitation is not an award, a
  Designation is a State action to verify with the Assessor, a Program record never says a user
  qualifies, an awardee point is a past round with a stale vintage, an election rule is as published.
- Place, not person: STC cover letters (which name an individual contact) are not parsed, only the
  certificate pages (entity, address, local unit). The certification register's contact fields are not
  used. DBL liaison names are not stored. The elections pack contains no personal lookups; MVIC
  registration, ballot tracking and sample-ballot pages are link-outs.
- The Program Registry and the Elections pack are **authored** files (`registry.json`, `pack.json`) with a
  schema test; edits are reviewed like code. Bump `registry_version` / `pack_version` when changing them.
- Raw archive is immutable: a re-fetch that produces the same sha256 is a no-op; a different sha256 gets a
  new timestamped file next to the old one.

## NDJSON shapes for city-api (`data/normalized/*.ndjson`)

`usaspending.ndjson` — **Agreement**
```json
{"agreement_id":"CONT_AWD_…","level":"federal","award_group":"contracts|grants","award_id":"…","recipient":"…","amount":26690.4,"agency":"…","sub_agency":"…","start":"YYYY-MM-DD","end":"YYYY-MM-DD|null","description":"…","place_of_performance":{"city_code":"MI22000","state_code":"MI","country_code":"USA","zip5":"…"}|null,"fiscal_year":2026,"source_id":"usaspending","source_url":"https://www.usaspending.gov/award/…","observed_at":"ISO","limitations":["A federal award records money obligated, not work performed."]}
```

`bonfire.ndjson` — **Solicitation** (empty while blocked)
```json
{"ref":"…","title":"…","department":"…","close_at":"ISO|null","close_at_as_published":"…","days_left":9|null,"url":"https://detroit.bonfirehub.com/opportunities/…","type_guess":"RFP|RFQ|RFI|bid|sole-source|unknown","source_id":"bonfire","observed_at":"ISO","limitations":["An open solicitation is not an award."]}
```

`programs.ndjson` — **Program**
```json
{"id":"motor-city-match","name":"…","administrator":"…","kind":"grant|loan|certification|registration|support","eligibility_summary_as_published":"…","award_range":"…|null","application_window":"YYYY-MM-DD..YYYY-MM-DD|rolling|unknown","geography_rule":"…","official_url":"https://…","verified_on":"YYYY-MM-DD","verification_note":"…","details":{…},"limitations":["Eligibility is determined by the administrator; this app never states that a user qualifies."],"source_id":"programs","observed_at":"ISO"}
```

`mcm-cash-awardees.ndjson`, `mcrs-awardees.ndjson` — **AwardeePoint**
```json
{"awardee_id":"mcm-cash-awardees:12","program_id":"motor-city-match|motor-city-re-store","round":"…","track":"…|null","business":"…","business_address":"…","description":"…","url":"…","parcelno":"…","lon":-83.1,"lat":42.4,"vintage":{"layer_last_edit":"ISO","item_modified":"ISO","item_created":"ISO","stale_warning":"…"},"source_id":"…","source_url":"https://services2.arcgis.com/…/FeatureServer/0","observed_at":"ISO","limitations":["A past awardee point shows where an earlier round landed; …"]}
```

`mi-stc.ndjson` (Detroit) and `mi-stc-statewide.ndjson` — **Designation**
```json
{"program":"OPRA|IFT|CRA","certificate_no":"3-24-0029","applicant_entity":"…","address":"…","local_unit":"City of Detroit","city":"Detroit","county":"Wayne","approved_date":"YYYY-MM-DD","approved_date_as_published":"August 18, 2026","term_years":12,"begins":"YYYY-MM-DD","ends":"YYYY-MM-DD","real_property_investment":4768515,"page":2,"pdf_url":"https://www.michigan.gov/…pdf","pdf_sha256":"…","source_id":"mi-stc","observed_at":"ISO","limitations":["A certificate records a State Tax Commission action as published; verify with the Assessor."]}
```

`elections.ndjson` — three record types distinguished by `record_type`
```json
{"record_type":"rule","election_date":"2026-11-03","rule_key":"registration.online_or_mail_deadline","value_as_published":"…","official_url":"https://…","corroborating_url":"https://…","verified_on":"2026-09-21","source_id":"elections","observed_at":"ISO","limitations":["Rules as published by the Department of Elections; confirm on the official page before acting."]}
{"record_type":"site","election_date":"2026-11-03","site_id":"site:department-of-elections","name":"…","address_as_published":"…","roles":["early_vote_center","drop_box","register_to_vote"],"status_as_published":"Early Vote Centers closed for this election","hours_as_published":null,"lon":null,"lat":null,"geocode_note":"address only; not geocoded (match against the City address point layer in city-api)","official_url":"https://detroitvotes.org/early/","verified_on":"YYYY-MM-DD","source_id":"elections","observed_at":"ISO","limitations":[…]}
{"record_type":"link_out","election_date":"2026-08-04|null","link_key":"wayne-county.aug-4-2026-primary.official-summary","title":"…","url":"https://…","status_as_published":"Official|null","verified_on":"2026-09-21","source_id":"elections","observed_at":"ISO","limitations":[…]}
```

Sites are stored with addresses only; geocoding is left to city-api's address-point matcher so one
geocoder serves every connector. The early-vote dates/hours live in the `early_voting.dates_and_hours`
rule; the site page's per-site status flag is captured verbatim (`status_as_published`).

`data/manifest.json` carries, per source, `fetched_at` (always), `source_updated` (HTTP Last-Modified
for PDFs, layer last-edit for ArcGIS, `verified_on`/version for authored files, null for USAspending
which publishes none on this endpoint), record counts, raw-file refs with sha256, and `status`
(`ok` | `partial` | `blocked`) with a note.
