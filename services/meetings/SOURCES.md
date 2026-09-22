# Sources — verified live 2026-09-21

Everything below was read on 2026-09-21 with the identifying User-Agent
`DetroitCityIntelligence/0.1 (+https://github.com/gparker195/detroit-city-intelligence-pipeline)` at no more than one
request per two seconds. Re-verify before changing a URL or selector; the PRD's rule is "verify live and date it".

## 1. City-Bureau/city-scrapers-det (MIT, pushed 2026-09-02): what the spiders actually target

Read from `city_scrapers/spiders/*.py` and `city_scrapers/mixins/det_city.py` via `gh api` on 2026-09-21.

| Spider | Target host today | Mechanism | eScribe? |
|---|---|---|---|
| `det_city_council` | `detroitmi.gov` | `DetCityMixin`, `agency_cal_id="296"`: `https://detroitmi.gov/Calendar-and-Events?...` event listing, then each `/events/...` page; last spider edit 2023-08-21 | **No** |
| `det_city_planning` | `detroitmi.gov` | `DetCityMixin`, `agency_cal_id="1591"`, `agency_doc_id=["3761","5316"]` (`https://detroitmi.gov/documents?...`) | No |
| `det_zoning_appeals` | `detroitmi.gov` | `DetCityMixin`, `agency_cal_id="1536"`, `agency_doc_id="3506"` | No |
| `det_historic_district` | `detroitmi.gov` | `DetCityMixin`, `agency_cal_id="1636"`, `agency_doc_id=["1636","3776"]` | No |
| `det_land_bank` | `buildingdetroit.org` | `start_urls=["https://buildingdetroit.org/events/meetings"]`; reads a `var meeting = [...]` JSON blob out of an inline script | No |
| `det_brownfield_redevelopment_authority` | `degc.org` | `DetAuthorityMixin`: `https://www.degc.org/public-authorities/` then `agency_url="https://www.degc.org/dbra/"` | No |
| `det_downtown_development_authority` | `degc.org` | `DetAuthorityMixin`, `agency_url="https://www.degc.org/dda/"` | No |
| `det_economic_development_corporation` | `degc.org` | `DetAuthorityMixin`, `agency_url="https://www.degc.org/edc/"` | No |

Conclusion: **none of the eight spiders reads eScribe.** `det_city_council` reads the City's general events
calendar on `detroitmi.gov` (Drupal `Calendar-and-Events` list + per-event pages, title/tag filtering for
"budget", "District", "Coffee"), not the Legislative Information Portal. The mixin was still being maintained on
2026-09-01 (location fallback fix, shared spider contract), so the repo is alive, but its Council coverage is the
City events calendar, which carries meeting dates and links, not agenda items, actions, or votes.

What this folder reuses from city-scrapers-det: the standardized meeting shape (title, start, location, links,
source), the body-classification idea, and the frozen-fixture contract-test pattern. What it does not reuse: the
Scrapy runtime and the `detroitmi.gov` selectors, because the record of action lives on eScribe. A later
`detroitmi.gov` connector for CPC agendas and BZA minutes (PRD, Journey 4) can lift `DetCityMixin`'s URL
patterns (`Calendar-and-Events?...`, `documents?...`) directly.

The 21-spider count in the PRD building-blocks table is right; the "verify each spider still targets eScribe"
item resolves as: they never did.

## 2. eScribe portal — `https://pub-detroitmi.escribemeetings.com/`

- `robots.txt` (HTTP 200, `server: cloudflare`): only `User-agent: PetalBot / Disallow: /`. Nothing disallowed for us.
- `GET /` and `GET /MeetingsCalendarView.aspx`: 200, ~245 KB, no challenge. The page contains **no ICS/iCal
  feed** (the "ical" hits are CSS `vertical-align`) and no server-rendered meeting list; meetings are loaded by the
  page's own JavaScript through ASP.NET page methods:
  - `POST /MeetingsCalendarView.aspx/GetCalendarMeetings`, `Content-Type: application/json`,
    body `{"calendarStartDate":"<ISO>","calendarEndDate":"<ISO>"}` (the page sends FullCalendar's
    `info.startStr`/`info.endStr`). Response `{"d":[...]}`; each meeting has `ID` (GUID), `MeetingName`,
    `MeetingType`, `StartDate` `"YYYY/MM/DD HH:MM:SS"`, `Location`, `MeetingPassed`, `HasAgenda`,
    `MeetingDocumentLink[]` with `Type` in `Agenda | PostMinutes | Video` and `Url` (both a
    `/FileStream.ashx?DocumentId=N` PDF and a `/Meeting.aspx?Id=<GUID>&Agenda=Agenda|PostMinutes&lang=English`
    HTML view). September 2026 returned 10 meetings, 37.7 KB.
  - `POST /MeetingsCalendarView.aspx/PastMeetings`, body `{"type":"<MeetingType>","pageNumber":1}` →
    `{"d":{"TotalCount":195,"Meetings":[50 per page]}}` (Formal Session: 195 past meetings).
  - Other page methods seen and **not used**: `AgendaItemConflictsGetAll`, `SubscriptionLists*` (email subscriptions).
- Meeting-type list embedded in the calendar page (28 names). Allowlisted here: City Council Formal Session,
  City Council Special Session, Committee of the Whole, City Council Budget Hearings, the five Standing
  Committees (Budget/Finance/Audit; Internal Operations; Neighborhood and Community Services; Planning and
  Economic Development; Public Health and Safety) plus Rules Standing Committee, Community Development Block Grant.
  Excluded as test/demo/training: `08222019 Mock Meeting Test`, `Automation Test Meeting`, `City Clerk Mock
  Meeting 1/2`, `City Clerk Training Agenda`, `City Clerk Training Meeting Type`, `Council Member Andre Spivey's
  Demo Meeting`, `James Test`, `Jeff Test`, `Keith's Demo Meeting`, `OCP Demo Meeting`, `Training James`,
  `eSCRIBE Meeting Type`, `eSCRIBE Team 1`. Deliberately not ingested (public but out of scope): Closed Session,
  Executive Session, Evening Community Meeting.
- Agenda HTML `GET /Meeting.aspx?Id=<GUID>&Agenda=Agenda&lang=English`: 200, ~447 KB. Minutes HTML
  `...&Agenda=PostMinutes&lang=English`: 200, ~751 KB. Markup documented in `meetings/escribe/agenda.py`.
  Items: `AgendaItemCounter` (e.g. `7.1`), `AgendaItemTitle`, `AgendaItemHeader` (group header, printed once),
  `AgendaItemDescription RichText` (agenda text), `AgendaItemMinutes RichText` (recorded action, e.g.
  `Approved 9-0`, `REFER TO THE COMMITTEE 9-0`, `Remove from agenda 9-0`, `Postpone 8-0`), attachment links
  `filestream.ashx?DocumentId=N` with `data-original-title` file names.
- Votes: minutes publish the tally as text. The "Vote Result" modal is filled client-side and the page embeds no
  per-member roll call, so `Vote.roll_call` is null for eScribe with `roll_call_basis` saying so.
- File numbers: eScribe items carry no legislation number in the HTML; petition numbers (`2026-157`) appear in
  titles/descriptions/attachment names and are captured as `file_number` when the `20YY-NNN` pattern is present.
- **Cloudflare:** `GET /filestream.ashx?DocumentId=277509` (attachment PDF) answered **403 with the
  "Just a moment..." challenge page** (`challenges.cloudflare.com`), while every `Meeting.aspx` and page-method
  request answered 200. The connector fetches PDFs last, stops at the first challenge, never retries in-run and
  never attempts to solve it. Attachment `Document` records then carry `extraction_status: fetch_blocked`.
- Terms: no automation terms found on the portal; PRD still requires confirmation with the City Clerk before
  scheduled ingestion ships.

## 3. Legistar Web API — `https://webapi.legistar.com/v1/detroit`

- `GET /events?$top=2&$orderby=EventDate desc` → 200; newest event `EventId 1827`, `EventDate 2017-03-30`
  (Neighborhood and Community Services Standing Committee). Archive only, as the PRD says.
- `GET /events/1827/eventitems?AgendaNote=1&MinutesNote=1&Attachments=1` → 200, 23 items with
  `EventItemAgendaNumber`, `EventItemTitle`, `EventItemActionName/Text`, `EventItemPassedFlagName`,
  `EventItemTally`, `EventItemRollCallFlag`, `EventItemMatterFile`, `EventItemMatterAttachments`.
- `GET /matters?$top=1&$filter=year(MatterIntroDate) eq 2016` → 200 (`MatterFile "15-0997"`, `MatterTypeName`,
  `MatterStatusName`, `MatterBodyName`).
- `GET /bodies` → 10 bodies: Budget, Finance and Audit Standing Committee; Budget, Finance and Audit/Internal
  Operations Standing Committee; City Council; City Council New Business; Internal Operations Standing
  Committee; Neighborhood and Community Services Standing Committee; Planning and Economic Development Standing
  Committee; Planning and Economic Development/Neighborhood and Community Services Standing Committee; Public
  Health and Safety Standing Committee; Rules Committee. Mapped in `config.BODY_ALLOWLIST`.
- Agenda PDFs are hosted on `legistar.granicus.com` (200, `application/pdf`, no challenge); one is the PDF fixture.

## 4. Libraries

- `pdfplumber` 0.11.10 (MIT) on Python 3.14.7 for page-referenced PDF text. Everything else is the standard library.
