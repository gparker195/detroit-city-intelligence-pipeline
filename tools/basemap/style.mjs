#!/usr/bin/env node
/**
 * Emit the Atlas basemap style: Protomaps "dark" flavor layers (CC0 style,
 * @protomaps/basemaps 5.7.2) for source "protomaps", retinted toward the
 * Luminous Municipal Atlas palette (the design-token values are inlined below; the
 * token source lives in the private monorepo, packages/design-tokens).
 *
 * Retint rules: background = earth.night; water darker than land; roads as thin
 * desaturated cool-grey lines (the app draws its own luminous centerlines on top);
 * labels in cool grey with a soft halo; parks = park.field; POIs hidden except transit.
 * Output: tools/basemap/style.detroit-dark.json and tools/basemap/public/basemap/style.detroit-dark.json
 */
import { writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { layers as protomapsLayers, namedFlavor } from "@protomaps/basemaps";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = process.env.DCI_BASEMAP_DIR ? resolve(process.env.DCI_BASEMAP_DIR) : join(HERE, "public", "basemap");
// Design-token values copied verbatim from packages/design-tokens/build/ts/tokens.ts (private monorepo, 2026-09-22).
const tokens = {
  "color-earth-night": "#071019",
  "color-land-paper": "#1B2431",
  "color-land-paper-edge": "#2E3A4B",
  "color-park-field": "#16302A",
  "color-evidence-cyan": "#5CC8E6",
  "color-text-primary": "#E6E9EF",
  "color-text-secondary": "#A9B4C2",
  "color-text-muted": "#6B7684",
};

export const SOURCE_ID = "protomaps";
export const PMTILES_URL = "pmtiles:///basemap/detroit-metro.pmtiles";
export const ATTRIBUTION = '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>, <a href="https://protomaps.com">Protomaps</a>';

const night = tokens["color-earth-night"];        // #071019
const paper = tokens["color-land-paper"];         // #1B2431
const paperEdge = tokens["color-land-paper-edge"]; // #2E3A4B
const park = tokens["color-park-field"];          // #16302A
const textSecondary = tokens["color-text-secondary"]; // #A9B4C2
const textMuted = tokens["color-text-muted"];     // #6B7684
const cyan = tokens["color-evidence-cyan"];       // #5CC8E6

// Derived cool greys between the tokens (kept desaturated, blue-leaning).
const water = "#050B12";      // darker than land and than the background
const land = "#0E1620";       // earth: lighter than water, darker than paper buildings
const landuse = "#111A25";    // generic landuse (hospital/school/industrial/pedestrian)
const casing = "#0A121B";     // road casings sink into the land
const roadMinor = "#212B38";
const roadMajor = "#2A3544";
const roadHighway = "#33405A";
const rail = "#1F2937";
const boundary = "#3A4657";

function flavor() {
  const f = namedFlavor("dark");
  Object.assign(f, {
    background: night,
    earth: land,
    park_a: park,
    park_b: park,
    wood_a: park,
    wood_b: park,
    scrub_a: "#14261F",
    scrub_b: "#14261F",
    hospital: landuse,
    industrial: "#0F1720",
    school: landuse,
    pedestrian: landuse,
    glacier: land,
    sand: "#141C27",
    beach: "#141C27",
    aerodrome: landuse,
    runway: paperEdge,
    water,
    zoo: landuse,
    military: "#0F1720",
    pier: paper,
    buildings: paper,
    other: roadMinor,
    minor_service: roadMinor,
    minor_a: roadMinor,
    minor_b: roadMinor,
    link: roadMajor,
    major: roadMajor,
    highway: roadHighway,
    railway: rail,
    boundaries: boundary,
    boundaries_country: boundary,
    roads_label_minor: textMuted,
    roads_label_minor_halo: night,
    roads_label_major: textSecondary,
    roads_label_major_halo: night,
    ocean_label: textMuted,
    peak_label: textMuted,
    subplace_label: textSecondary,
    subplace_label_halo: night,
    city_label: tokens["color-text-primary"],
    city_label_halo: night,
    state_label: textMuted,
    state_label_halo: night,
    country_label: textMuted,
    address_label: textMuted,
    address_label_halo: night,
    waterway_label: textMuted,
  });
  for (const k of Object.keys(f)) {
    if (/casing/.test(k)) f[k] = casing;
    if (/^tunnel_(other|minor|link|major|highway)$/.test(k)) f[k] = roadMinor;
    if (/^bridges_(other|minor|link)$/.test(k)) f[k] = roadMinor;
    if (/^bridges_(major|highway)$/.test(k)) f[k] = roadMajor;
  }
  return f;
}

const ROAD_WIDTH_SCALE = 0.7; // thin lines; the app's luminous centerlines carry the emphasis

/** Scale a numeric width or the output stops of a zoom interpolate/step (zoom may only sit at the top level). */
function scaleWidth(expr, k) {
  if (typeof expr === "number") return Math.round(expr * k * 100) / 100;
  if (!Array.isArray(expr)) return expr;
  if (expr[0] === "interpolate") return [expr[0], expr[1], expr[2], ...expr.slice(3).map((v, i) => (i % 2 === 1 ? scaleWidth(v, k) : v))];
  if (expr[0] === "step") return [expr[0], expr[1], scaleWidth(expr[2], k), ...expr.slice(3).map((v, i) => (i % 2 === 1 ? scaleWidth(v, k) : v))];
  return expr;
}
const TRANSIT_KINDS = ["aerodrome", "station", "bus_stop", "ferry_terminal", "tram_stop", "subway_entrance"];

function retintLayer(l) {
  if (l.type === "line" && l["source-layer"] === "roads" && l.paint?.["line-width"] !== undefined) {
    l.paint["line-width"] = scaleWidth(l.paint["line-width"], ROAD_WIDTH_SCALE);
    if (l.paint["line-gap-width"] !== undefined) l.paint["line-gap-width"] = scaleWidth(l.paint["line-gap-width"], ROAD_WIDTH_SCALE);
    if (!/casing/.test(l.id)) l.paint["line-opacity"] = 0.85;
  }
  if (l.type === "symbol") {
    l.paint ??= {};
    if (l.paint["text-color"] !== undefined) {
      l.paint["text-halo-color"] = night;
      l.paint["text-halo-width"] = 1.2;
      l.paint["text-halo-blur"] = 0.6;
    }
    if (l.id === "pois") {
      // POIs mostly hidden: keep transit only, in evidence cyan with a soft halo.
      l.filter = ["all", ["in", ["get", "kind"], ["literal", TRANSIT_KINDS]], [">=", ["zoom"], ["+", ["get", "min_zoom"], 0]]];
      l.paint["text-color"] = cyan;
      l.paint["text-opacity"] = 0.85;
      l.paint["icon-opacity"] = 0.7;
    }
    if (l.id === "roads_oneway") l.layout = { ...l.layout, visibility: "none" };
    if (l.id === "address_label") l.layout = { ...l.layout, visibility: "none" };
  }
  return l;
}

export function buildStyle() {
  const layers = protomapsLayers(SOURCE_ID, flavor(), { lang: "en" }).map(retintLayer);
  return {
    version: 8,
    name: "Luminous Municipal Atlas — Detroit dark basemap",
    metadata: {
      "dci:generator": "tools/basemap/style.mjs",
      "dci:basemaps": "@protomaps/basemaps 5.7.2 (BSD-3-Clause), Protomaps basemap style CC0",
      "dci:data": "OpenStreetMap contributors, ODbL; rendered Produced Work only, never merged into evidence",
      "dci:tokens": "design-token values inlined in tools/basemap/style.mjs (source: private monorepo packages/design-tokens)",
      "dci:sprite-note": "MapLibre requires an absolute sprite URL; the loader must set style.sprite = new URL(style.sprite, location.origin).href (glyphs may stay relative).",
    },
    // Self-hosted assets (no key, no third party at runtime):
    glyphs: "/basemap/fonts/{fontstack}/{range}.pbf",   // Noto Sans, SIL OFL 1.1
    sprite: "/basemap/sprites/v4/dark",                  // tangrams icons, MIT (absolutize at load time, see metadata)
    sources: {
      [SOURCE_ID]: { type: "vector", url: PMTILES_URL, attribution: ATTRIBUTION },
    },
    layers,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(HERE, "style.detroit-dark.json");
  writeFileSync(out, JSON.stringify(buildStyle(), null, 2) + "\n");
  mkdirSync(PUBLIC_DIR, { recursive: true });
  copyFileSync(out, join(PUBLIC_DIR, "style.detroit-dark.json"));
  console.log(`[basemap] wrote ${out} and copied to ${PUBLIC_DIR}`);
}
