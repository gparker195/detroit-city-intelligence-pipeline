# Third-party notices

This file holds the license texts and attribution notices for every third-party component and data source used by the pipeline, as listed in the product PRD ("Open-source building blocks" and "Ship readiness"). Add an entry per dependency when it is introduced.

Runtime attributions that must be visible wherever the data is displayed: OpenStreetMap contributors (ODbL), Protomaps (basemap style CC0), AWS Open Data Terrain Tiles / Mapzen (Terrarium), NASA GIBS, City of Detroit Open Data (AS-IS disclaimer), Detroit Land Bank Authority, Wayne County, State of Michigan.

## Basemap third-party notices

- **OpenStreetMap data** in `detroit-metro.pmtiles` (extracted from the Protomaps daily planet build recorded in `tools/basemap/detroit-metro.meta.json`): © OpenStreetMap contributors, Open Database License (ODbL) 1.0. Rendered as a Produced Work; never merged into the evidence database. Attribution "© OpenStreetMap contributors" is displayed wherever the basemap renders.
- **Protomaps basemap style and tiles pipeline** (`@protomaps/basemaps`, style design): BSD-3-Clause (code), CC0 (cartographic design). Attribution "Protomaps" displayed.
- **go-pmtiles CLI** (`tools/basemap/bin`, downloaded at build time): BSD-3-Clause, Protomaps LLC.
- **Noto Sans glyphs** (`tools/basemap/public/basemap/fonts`, downloaded by `tools/basemap/fetch-assets.mjs`): SIL Open Font License 1.1 (LICENSE file alongside).
- **tangrams/icons sprites** (`tools/basemap/public/basemap/sprites`, downloaded by `tools/basemap/fetch-assets.mjs`): MIT (LICENSE file alongside).
- **AWS Open Data Terrain Tiles** (Terrarium): Mapzen/Tilezen terrain tiles via AWS Open Data; attribution displayed (used by the Atlas app, not by this pipeline).

## Data sources

- **City of Detroit Open Data Portal** (ArcGIS feature services): "Provided AS-IS by the City of Detroit Open Data Portal; no warranty as to accuracy, timeliness, or completeness." Per-source attribution (City of Detroit, Detroit Land Bank Authority via the City, Michigan Liquor Control Commission / LARA via the City) is recorded in `services/ingest/src/registry/sources.ts` together with the zoning map disclaimer that must be shown next to zoning records.
- **Detroit City Clerk, eScribe portal and Legistar Web API**: council agendas, minutes, votes and document metadata as published (`services/meetings`).
- **USAspending.gov** (federal awards, Detroit place of performance), **Michigan State Tax Commission** certificate lists (michigan.gov), **Detroit Department of Elections / detroitvotes.org**, **Wayne County**, **DEGC** program pages, and the City's Motor City Match / Re-Store awardee layers (`services/civic`).

## Code dependencies

| Package | Used by | License |
|---|---|---|
| typescript, @types/node | all TypeScript packages | Apache-2.0 / MIT |
| playwright | services/civic (michigan.gov reads), tools/basemap (render smoke test) | Apache-2.0 |
| pdfjs-dist | services/civic (State Tax Commission PDFs) | Apache-2.0 |
| pdfplumber (and pdfminer.six) | services/meetings (agenda PDFs) | MIT |
| pmtiles (npm) | tools/basemap tests | BSD-3-Clause |
| @protomaps/basemaps | tools/basemap style generator | BSD-3-Clause (code), CC0 (style) |
| maplibre-gl | tools/basemap render smoke test | BSD-3-Clause |
