/**
 * Render smoke test: static-serve tools/basemap/public (with HTTP Range
 * support for PMTiles; populated by build.sh, fetch-assets.mjs and style.mjs), load the generated style in MapLibre GL under
 * Playwright Chromium (Apache-2.0), render one frame at Livernois & McNichols
 * zoom 15, save tools/basemap/smoke.png, and assert no console errors and that
 * at least one symbol layer rendered features.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PUBLIC = process.env.DCI_BASEMAP_DIR ? resolve(process.env.DCI_BASEMAP_DIR, "..") : join(ROOT, "public");
const READY = existsSync(join(PUBLIC, "basemap", "detroit-metro.pmtiles")) && existsSync(join(PUBLIC, "basemap", "fonts")) && existsSync(join(PUBLIC, "basemap", "style.detroit-dark.json"));
const SKIP = READY ? false : "basemap not built (run ./build.sh, node fetch-assets.mjs, node style.mjs); render smoke test skipped";
const VENDOR = join(ROOT, "node_modules");
const CENTER = [-83.1404, 42.4165]; // Livernois Ave & W McNichols Rd
const ZOOM = 15;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".pbf": "application/x-protobuf", ".pmtiles": "application/octet-stream" };

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/_vendor/maplibre-gl/dist/maplibre-gl.css">
<style>html,body,#map{margin:0;width:1024px;height:768px;background:#071019}</style></head>
<body><div id="map"></div>
<script src="/_vendor/pmtiles/dist/pmtiles.js"></script>
<script type="module">
import * as maplibregl from "/_vendor/maplibre-gl/dist/maplibre-gl.mjs";
maplibregl.addProtocol("pmtiles", new pmtiles.Protocol().tile);
const style = await (await fetch("/basemap/style.detroit-dark.json")).json();
style.sprite = new URL(style.sprite, location.origin).href; // MapLibre requires an absolute sprite URL
const map = new maplibregl.Map({ container: "map", style, center: [${CENTER}], zoom: ${ZOOM}, attributionControl: true, fadeDuration: 0 });
window.__map = map;
map.once("idle", () => {
  const symbols = map.getStyle().layers.filter((l) => l.type === "symbol" && l.layout?.visibility !== "none").map((l) => l.id);
  const counts = {};
  for (const id of symbols) counts[id] = map.queryRenderedFeatures({ layers: [id] }).length;
  const roads = map.queryRenderedFeatures({ layers: ["roads_minor", "roads_major"] }).length;
  const names = map.queryRenderedFeatures({ layers: ["roads_labels_minor", "roads_labels_major"] }).map((f) => f.properties.name);
  window.__result = { counts, roads, names: [...new Set(names)] };
});
</script></body></html>`;

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/smoke.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end(PAGE); }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    const file = rel.startsWith("/_vendor/") ? join(VENDOR, rel.slice("/_vendor/".length)) : join(PUBLIC, rel);
    if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    const size = statSync(file).size;
    const type = MIME[extname(file)] ?? "application/octet-stream";
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

test("MapLibre renders the Detroit dark basemap at Livernois & McNichols z15 with symbol features", { skip: SKIP }, async () => {
  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("requestfailed", (r) => errors.push(`requestfailed ${r.url()} ${r.failure()?.errorText}`));
    page.on("response", (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
    await page.goto(`http://127.0.0.1:${port}/smoke.html`);
    try {
      await page.waitForFunction(() => window.__result, null, { timeout: 60_000 });
    } catch (e) {
      throw new Error(`map never became idle: ${e.message}\nerrors so far:\n${errors.join("\n")}`);
    }
    const result = await page.evaluate(() => window.__result);
    await page.screenshot({ path: join(ROOT, "smoke.png") });
    console.log("symbol features per layer:", JSON.stringify(result.counts));
    console.log("road lines rendered:", result.roads, "| street names:", result.names.slice(0, 12).join(", "));
    assert.deepEqual(errors, [], "no console/network errors");
    assert.ok(Object.values(result.counts).some((n) => n > 0), "at least one symbol layer rendered features");
    assert.ok(result.roads > 0, "road lines rendered");
    assert.ok(result.names.some((n) => /Livernois|McNichols/i.test(n)), `expected Livernois/McNichols among labels: ${result.names.join(", ")}`);
  } finally {
    await browser.close();
    server.close();
  }
});
