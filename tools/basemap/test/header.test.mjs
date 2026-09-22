import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PMTiles } from "pmtiles";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const ARCHIVE = join(ROOT, "detroit-metro.pmtiles");
// The extract is not committed (73 MB, ODbL rendered work published as a release asset); run build.sh to test it.
const NO_ARCHIVE = existsSync(ARCHIVE) ? false : "detroit-metro.pmtiles not built (run ./build.sh); header and meta tests skipped";
const STUDY = { west: -83.6, south: 42.1, east: -82.8, north: 42.6 };
const LIVERNOIS_MCNICHOLS = [-83.1404, 42.4165];
const DOWNTOWN = [-83.0458, 42.3314];

function rangeSource(path) {
  const fd = readFileSync(path); // 77 MB; fine for a test, avoids partial-read plumbing
  return { getKey: () => path, getBytes: async (offset, length) => ({ data: fd.buffer.slice(fd.byteOffset + offset, fd.byteOffset + offset + length) }) };
}

test("detroit-metro.pmtiles header covers the study area at maxzoom >= 14", { skip: NO_ARCHIVE }, async () => {
  const p = new PMTiles(rangeSource(ARCHIVE));
  const h = await p.getHeader();
  assert.equal(h.tileType, 1, "MVT tile type");
  assert.ok(h.minLon <= STUDY.west && h.minLat <= STUDY.south && h.maxLon >= STUDY.east && h.maxLat >= STUDY.north,
    `bbox ${[h.minLon, h.minLat, h.maxLon, h.maxLat]} must cover ${JSON.stringify(STUDY)}`);
  assert.ok(h.maxZoom >= 14, `maxZoom ${h.maxZoom} >= 14`);
  for (const [lon, lat] of [LIVERNOIS_MCNICHOLS, DOWNTOWN]) {
    assert.ok(lon >= h.minLon && lon <= h.maxLon && lat >= h.minLat && lat <= h.maxLat, `${lon},${lat} inside archive bbox`);
  }
  const meta = await p.getMetadata();
  assert.ok(String(meta.attribution ?? "").includes("OpenStreetMap"), "OSM attribution present in archive metadata");
  const layers = (meta.vector_layers ?? []).map((l) => l.id);
  for (const id of ["roads", "places", "water", "landuse"]) assert.ok(layers.includes(id), `vector layer ${id}`);
  // A z15 tile exists at Livernois & McNichols.
  const z = 15, n = 2 ** z;
  const x = Math.floor(((LIVERNOIS_MCNICHOLS[0] + 180) / 360) * n);
  const latR = (LIVERNOIS_MCNICHOLS[1] * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n);
  const tile = await p.getZxy(z, x, y);
  assert.ok(tile && tile.data.byteLength > 0, `z15 tile ${x}/${y} present`);
});

test("meta.json matches the archive on disk and records provenance", { skip: NO_ARCHIVE }, () => {
  const meta = JSON.parse(readFileSync(join(ROOT, "detroit-metro.meta.json"), "utf8"));
  assert.equal(meta.sizeBytes, statSync(ARCHIVE).size);
  assert.match(meta.sha256, /^[0-9a-f]{64}$/);
  assert.match(meta.pmtilesCliUrl, /^https:\/\/github\.com\/protomaps\/go-pmtiles\/releases\/download\/v1\.31\.2\//);
  assert.match(meta.buildDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(meta.sourceUrl, /^https:\/\/build\.protomaps\.com\/\d{8}\.pmtiles$/);
  assert.ok(meta.maxzoom >= 14);
  assert.equal(meta.attribution, "© OpenStreetMap contributors");
});

test("style.detroit-dark.json keeps the OSM attribution, palette and self-hosted assets", () => {
  const style = JSON.parse(readFileSync(join(ROOT, "style.detroit-dark.json"), "utf8"));
  assert.equal(style.sources.protomaps.url, "pmtiles:///basemap/detroit-metro.pmtiles");
  assert.ok(style.sources.protomaps.attribution.includes("© OpenStreetMap contributors"));
  assert.equal(style.layers.find((l) => l.type === "background").paint["background-color"], "#071019");
  assert.ok(style.glyphs.startsWith("/basemap/fonts/"));
  assert.ok(style.sprite.startsWith("/basemap/sprites/"));
  const pois = style.layers.find((l) => l.id === "pois");
  assert.deepEqual(pois.filter[1][2][1].slice(0, 3), ["aerodrome", "station", "bus_stop"], "POIs limited to transit kinds");
  assert.ok(style.layers.some((l) => l.type === "symbol" && l["source-layer"] === "roads"), "road label layers present");
});
