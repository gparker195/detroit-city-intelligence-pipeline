# services/meetings/data — generated, git-ignored except this file

```text
data/
  raw/                                immutable archive; never rewritten, only appended
    escribe/<meeting_id>/             one folder per eScribe meeting (GUID from the calendar)
      <sha256>.html | .pdf | .json    content-addressed body; the same bytes are written once
      index.json                      [{kind, url, sha256, bytes, content_type, first_fetched_at,
                                        last_fetched_at, path}] ; kind in
                                        calendar | agenda_html | minutes_html | attachment_pdf
    legistar/<year>/<event_id>/       Legistar API responses (event.json, eventitems.json, votes_<id>.json)
      <sha256>.json + index.json      same layout
    calendar/                         each GetCalendarMeetings / PastMeetings response, content-addressed
  discovery/<run_id>.json             meetings found per run (after the body allowlist), with the exact
                                      requests sent
  normalized/
    events.ndjson                     Event records (one per meeting)
    items.ndjson                      CouncilItem records
    votes.ndjson                      Vote records
    documents.ndjson                  Document records (agenda/minutes HTML and PDFs, with page text)
  manifest.json                       per-source run summary and the two dates
  runs/<run_id>.json                  request log: url, status, bytes, seconds, cloudflare flag
```

`sha256` is over the exact bytes fetched. `first_fetched_at` is kept forever; a re-fetch of identical
bytes only bumps `last_fetched_at`. Changed bytes get a new content-addressed file next to the old one.
