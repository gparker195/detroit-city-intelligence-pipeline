# Fixtures (recorded 2026-09-21, no network in tests)

- `usaspending-page.json`: a real `spending_by_award` shape (first two rows are the duplicate the API returned live), plus one synthetic grant row.
- `bonfire-rows.json`: synthetic rows in the shape the Bonfire table shows (Ref #, project, department, close date, days left). Synthetic because `detroit.bonfirehub.com/robots.txt` disallows all agents; titles mirror the PRD's 2026-09-21 description of the open list.
- `stc-opra-81826-lines.json`, `stc-ift-6-9-26-lines.json`: text lines per page extracted with pdf.js from the real Treasury PDFs `OPRA-New-Certificates-81826.pdf` and `IFT-New-Certificates-6-9-26.pdf` (fetched 2026-09-21). Cover-letter pages name individuals; the parser ignores those pages.
- `detroitvotes-early-2026-09-21.html`: the real `https://detroitvotes.org/early/` page as served 2026-09-21.
- `robots-*.txt`: real robots.txt bodies.
