# tools/basemap — keyless self-hosted vector basemap (Detroit metro)

Produces the street names, neighborhood labels, water and land use behind the
Atlas with **no third-party key and no third-party host at runtime**. Everything
here is a build tool; nothing is imported by the app source. The workflow rebuilds
the extract on Sundays and publishes it as a release asset (`detroit-metro.pmtiles`).

| Piece | What | License |
| --- | --- | --- |
| Data | Protomaps daily OpenStreetMap planet build, bbox-extracted over HTTP range requests | ODbL, "© OpenStreetMap contributors" |
| Extractor | `pmtiles` CLI (go-pmtiles v1.31.2, macOS arm64 or Linux x86_64, sha256 pinned in `build.mjs`) | BSD-3-Clause |
| Style | `@protomaps/basemaps` 5.7.2 "dark" flavor, retinted to the Atlas tokens | style CC0, package BSD-3-Clause |
| Glyphs | Noto Sans PBF ranges from protomaps/basemaps-assets | SIL OFL 1.1 |
| Sprites | `sprites/v4/dark*` from protomaps/basemaps-assets | MIT (tangrams/icons) |
| Tests | `node:test`, `pmtiles` npm (BSD-3), Playwright Chromium | Apache-2.0 |

The basemap is a rendered Produced Work only. **Never merge its data into the
evidence database** (ODbL share-alike; see AGENTS.md).

## Verified facts (2026-09-22)

* Daily builds live at `https://build.protomaps.com/YYYYMMDD.pmtiles` (~138 GB each,
  `accept-ranges: bytes`). The bare `https://build.protomaps.com/` root returns 404;
  the listing that maps.protomaps.com/builds reads is
  `https://build-metadata.protomaps.dev/builds.json` (`key`, `size`, `md5sum`, `b3sum`,
  `uploaded`, `version`). Latest at build time: `20260921.pmtiles`, tileset v4.15.2.
* go-pmtiles releases publish per-platform archives but **no checksum file**; the sha256
  of the macOS arm64 zip and the Linux x86_64 tarball we downloaded are pinned in `build.mjs`
  and recorded in the meta file. Set `PMTILES_STRICT_CHECKSUM=1` to make a mismatch fatal.
* basemaps-assets README: fonts are SIL OFL, sprites derive from MIT tangrams/icons.

## Usage

```sh
pnpm install              # from the repository root (Node 24)
cd tools/basemap
./build.sh                # discover latest build, fetch CLI, extract, write meta, copy to public/basemap/
node style.mjs            # regenerate style.detroit-dark.json (+ copy to public/basemap/)
node fetch-assets.mjs     # (re)download glyphs + sprites into public/basemap/
pnpm test                 # header test + Playwright render smoke test (writes smoke.png);
                          # both skip with a message until build.sh / fetch-assets.mjs have run
```

`DCI_BASEMAP_DIR` overrides the output folder (default `tools/basemap/public/basemap`, git-ignored);
`scripts/publish.sh` reads the same variable.

`build.sh` options: `--maxzoom N` (default 15), `--build YYYYMMDD` (pin a build),
`--skip-copy`. If a maxzoom-15 extract exceeds 200 MB the script rebuilds at 14 and
records that in `notes`. The Detroit metro bbox `-83.60,42.10,-82.80,42.60` at z15 came
out at 73 MB, so no reduction was needed.

Playwright needs a Chromium: `pnpm exec playwright install chromium` once.

## Outputs

* `detroit-metro.pmtiles` (gitignored) and `detroit-metro.meta.json` (build date, source
  URL, sha256, size, extract seconds, CLI version).
* `style.detroit-dark.json` — MapLibre style, source id `protomaps`, url
  `pmtiles:///basemap/detroit-metro.pmtiles`, glyphs `/basemap/fonts/{fontstack}/{range}.pbf`,
  sprite `/basemap/sprites/v4/dark`.
* Copies in `public/basemap/` (git-ignored); the workflow publishes them as release assets
  and inside the artifact folder.
* `smoke.png` — one frame at Livernois & McNichols, z15.

## Retint rules (design-token values inlined in `style.mjs`; the token source is the private monorepo)

background `color-earth-night` #071019; land #0E1620 with water #050B12 (darker than land);
buildings/piers `color-land-paper`; parks/woods `color-park-field`; roads thin (widths x0.7)
desaturated cool greys with casings sunk into the land, because the app draws its own
luminous centerlines on top; labels `color-text-secondary`/`color-text-muted` with a soft
night halo; POIs hidden except transit kinds (aerodrome, station, bus stop, ferry terminal,
tram stop, subway entrance) in `color-evidence-cyan`; one-way arrows and address labels off.

## Wiring the Atlas (in the private monorepo; notes kept here for consumers of the release)

* `BASEMAP_PMTILES_URL = "/basemap/detroit-metro.pmtiles"` in `apps/atlas-web/src/config.ts`
  (the existing code prefixes `pmtiles://`).
* Style: `/basemap/style.detroit-dark.json`, or keep building layers in `style.ts` and point
  glyphs/sprite at `/basemap/fonts/{fontstack}/{range}.pbf` and `/basemap/sprites/v4/dark`.
* MapLibre requires an **absolute** sprite URL: `style.sprite = new URL(style.sprite, location.origin).href`
  (glyphs accept a root-relative path). The `pmtiles` protocol must be registered
  (`maplibregl.addProtocol("pmtiles", new Protocol().tile)`), which `renderer/map.ts` already does.
* The static host must honor HTTP Range requests (Vite dev/preview and any object store do).
