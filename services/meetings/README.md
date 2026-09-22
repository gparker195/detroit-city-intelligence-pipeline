# services/meetings — eScribe + Legistar document connector (Milestone 2)

Reads Detroit City Council meetings from the City Clerk's eScribe portal (current record) and the Legistar
Web API (2012–2017 archive), archives every page and PDF immutably, and emits typed `Event`, `CouncilItem`,
`Vote`, `Document` records that match the product PRD (private monorepo), Journey 4. No LLM anywhere: item extraction,
lifecycle labels, tallies, and address candidates are regexes over verbatim text. No keys.

Self-contained on purpose (own venv, stdlib + `pdfplumber`) so it can be lifted into the public pipeline repo.
Live verification of every URL and selector is in `SOURCES.md` (dated 2026-09-21).

## Layout

```text
services/meetings/
  README.md, SOURCES.md, requirements.txt, .gitignore
  meetings/
    config.py               UA, 2 s rate, URLs, body allowlist + test/demo exclusion, LIMITATIONS sentence
    http.py                 stdlib fetcher: identifying UA, 1 req / 2 s per host, robots.txt, gzip,
                            Cloudflare challenge detection -> back off the host for the run (never bypass)
    records.py              Event / CouncilItem / Vote / Document / Provenance dataclasses -> dicts
    archive.py              content-addressed immutable raw archive (sha256, first/last fetched_at, index.json)
    lifecycle.py            recorded action text -> Scheduled|Referred|Approved|Deferred|Denied|Withdrawn|Unknown
    addresses.py            Detroit street / parcel / "Ward N Item N" regex candidates, always needs_review
    pdftext.py              pdfplumber page-referenced text
    escribe/calendar.py     discovery via the calendar page's own JSON method (documented request), allowlist
    escribe/agenda.py       deterministic parser for Meeting.aspx agenda + minutes HTML
    escribe/pipeline.py     meeting -> archive -> records; PDFs last; public-comment governance
    legistar.py             /events, /eventitems, /votes -> same records with source_id 'legistar'
    normalize.py            NDJSON merge/write + manifest.json (both dates)
    cli.py, __main__.py     discover | fetch | backfill --year | manifest
  tests/                    unittest, offline, recorded fixtures (real calendar JSON, real Formal Session
    fixtures/               agenda + minutes HTML, Legistar events/eventitems JSON, a Legistar agenda PDF,
                            the recorded Cloudflare 403 challenge page)
  data/                     generated, git-ignored except data/README.md (layout of raw/, normalized/, runs/)
```

## Commands

```sh
cd services/meetings
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # Python 3.12+

.venv/bin/python -m unittest discover -s tests -t . -v      # offline tests

.venv/bin/python -m meetings discover --back 60 --ahead 30  # 1 POST per calendar month; prints meetings per body
.venv/bin/python -m meetings fetch    --back 60 --ahead 30  # discover + archive agenda/minutes HTML, then PDFs, then normalize
.venv/bin/python -m meetings fetch --no-pdfs --limit 3      # HTML only, first three meetings
.venv/bin/python -m meetings backfill --year 2016 --limit 50 # Legistar: 50 events per run (1 + N + roll-call requests)
.venv/bin/python -m meetings manifest                       # rebuild data/manifest.json from data/normalized
```

Every run writes `data/runs/<run_id>.json` with each request (URL, status, bytes, seconds, challenge flag)
and `data/discovery/<run_id>.json` with the meetings and the exact JSON payloads sent.

## Access rules the code enforces

- User-Agent `DetroitCityIntelligence/0.1 (+https://github.com/gparker195/detroit-city-intelligence-pipeline)`; one
  request per two seconds per host; `robots.txt` checked before every URL (eScribe disallows only PetalBot).
- A Cloudflare challenge (`cf-mitigated: challenge`, or a 403/503 "Just a moment" page) marks the host backed
  off for the rest of the run. Nothing retries, nothing solves. On 2026-09-21 `filestream.ashx` (attachment
  PDFs) challenged while `Meeting.aspx` and the calendar method did not, so `fetch` reads every HTML page first
  and PDFs last; blocked attachments become `Document` records with `extraction_status: fetch_blocked`.
- No logins, no email subscriptions, no `PastMeetings` paging beyond what the window needs.

## Cadence

Daily, plus Monday and Tuesday mornings before Council sessions (PRD "Freshness"): agendas post days before the
Tuesday Formal Session and standing committees meet Monday–Thursday. `fetch --back 60 --ahead 30` is idempotent:
unchanged pages only bump `last_fetched_at`; changed pages get a new content-addressed file, so an agenda that is
amended between Friday and Tuesday keeps both versions. Suggested launchd/cron: `06:30 America/Detroit` daily and
`08:30` Monday/Tuesday. Legistar backfill is a one-time job run by year (`--limit 50` per invocation until a
year is exhausted; the API is an archive and does not change).

## Governance

- **Public comment** is attached to the item and meeting (`is_public_comment: true`) and never indexed by
  speaker: the minutes text of a public-comment item stays only in the raw archive; the normalized `CouncilItem`
  carries no `action_text`, no attachments, and no address candidates for it. No speaker profiles, no
  cross-meeting person search, ever.
- **A source is not a conclusion.** A meeting whose start has passed but whose minutes are not published stays
  `scheduled` with `status_basis` saying so; agenda items stay `Scheduled` until minutes record an action; the
  lifecycle label always sits next to the verbatim `action_text` and `lifecycle_basis` names the rule that fired.
  Every record carries `limitations: ["An agenda item is not an approval; an approval is not execution."]`.
- **Place, not person.** Sponsor/member names appear only inside verbatim titles or action text as published.
- **Addresses are candidates.** `address_candidates[].location_confidence` is always `needs_review`; resolution
  against the City's base units happens in a later stage with review.
- Terms: no automation terms were found on eScribe; the PRD requires confirming with the City Clerk before
  scheduled ingestion ships. Until then, run manually.

## Output shapes (how this joins city-api later)

`data/normalized/*.ndjson`, one JSON object per line, sorted by `effective_at` then id. Common fields on every
record: `record_type`, `source_id` (`escribe` | `legistar`), `source_snapshot_id` (run id),
`observed_at` (we fetched, UTC), `effective_at` (the City's date: meeting date), `source_url`,
`raw_sha256` (the archived page the record was read from), `limitations`.

```text
events.ndjson     Event      event_id "escribe:<guid>" | "legistar:<EventId>", body (canonical), name (as published),
                             date, start (local, as published), status scheduled|held|cancelled, status_basis,
                             location, agenda_url, minutes_url, agenda_pdf_url, minutes_pdf_url, video_url
items.ndjson      CouncilItem item_id "<event_id>:<escribe item N | legistar EventItemId>", event_id, body, meeting_date,
                             item_number "7.1", file_number (petition/MatterFile when published), title, section
                             ("PARENT TITLE / GROUP HEADER"), description (agenda text verbatim),
                             action_text (minutes verbatim, null until held), lifecycle, lifecycle_basis,
                             attachments [{title,url,document_id}], address_candidates [{text,kind,location_confidence}],
                             is_public_comment
votes.ndjson      Vote       vote_id "<item_id>:vote", item_id, event_id, motion (verbatim), result ("Approved",
                             "REFER TO THE COMMITTEE"), tally {yes,no} | null, roll_call [{member,vote}] | null,
                             roll_call_basis
documents.ndjson  Document   document_id, event_id, item_id|null, kind agenda_html|minutes_html|attachment_pdf|api_json,
                             title, url, sha256, bytes, content_type, fetched_at,
                             extraction_status extracted|no_text|html|json|not_fetched|fetch_blocked|fetch_failed|extraction_failed,
                             pages [{page, text}]
manifest.json                per source: source_updated_at (latest effective_at) and fetched_at (latest observed_at),
                             record counts, limitations, governance lines, last 50 run summaries
```

city-api joins on `event_id` / `item_id`, shows `effective_at` as "City updated" and `observed_at` as "we
fetched", renders `lifecycle` only next to `action_text`, and treats `address_candidates` as review-queue input,
not as locations. Legistar and eScribe ids never collide (prefixes), and gap years between the two systems are a
source gap, not "no activity".

## Known limits (2026-09-21)

- eScribe attachment PDFs are behind a Cloudflare challenge for plain HTTP clients; HTML agendas/minutes are not.
  One PDF (DocumentId 277672) was served before the challenge appeared, so the PDF path is proven but not reliable.
- eScribe publishes vote tallies as text ("Approved 9-0"); no per-member roll call is in the page, so
  `Vote.roll_call` is null for eScribe.
- Detroit's Legistar event items carry no per-event action text, passed flag, or tally (all null in the 2016 and
  2017 samples); items backfill as `Unknown` with the matter's published status noted in `lifecycle_basis`.
- First eScribe meeting date and eScribe/City Clerk automation terms are still to be confirmed (PRD open item).
