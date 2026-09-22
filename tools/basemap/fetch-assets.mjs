#!/usr/bin/env node
/**
 * Download the Protomaps basemap assets (glyphs + dark sprites) into
 * tools/basemap/public/basemap/{fonts,sprites} (or $DCI_BASEMAP_DIR) so the style
 * works with no third-party host at runtime. Licenses: fonts SIL OFL 1.1 (Noto Sans),
 * sprites MIT (tangrams/icons). Verified 2026-09-22 at
 * https://github.com/protomaps/basemaps-assets (README "License").
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = process.env.DCI_BASEMAP_DIR ? resolve(process.env.DCI_BASEMAP_DIR) : join(HERE, "public", "basemap");
const ZIP_URL = "https://github.com/protomaps/basemaps-assets/archive/refs/heads/main.zip";
const SPRITES_LICENSE_URL = "https://raw.githubusercontent.com/tangrams/icons/master/LICENSE.md";
const FONTS = ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"];
const UA = "DetroitCityIntelligence-basemap-build/0.1 (+https://github.com/gparker195/detroit-city-intelligence-pipeline)";

const tmp = mkdtempSync(join(tmpdir(), "basemaps-assets-"));
try {
  const zip = join(tmp, "assets.zip");
  const res = await fetch(ZIP_URL, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${ZIP_URL}`);
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  if (spawnSync("unzip", ["-q", "-o", zip, "-d", tmp]).status !== 0) throw new Error("unzip failed");
  const src = join(tmp, "basemaps-assets-main");
  const today = new Date().toISOString().slice(0, 10);

  const fonts = join(PUB, "fonts");
  mkdirSync(fonts, { recursive: true });
  for (const f of FONTS) cpSync(join(src, "fonts", f), join(fonts, f), { recursive: true });
  cpSync(join(src, "fonts", "OFL.txt"), join(fonts, "LICENSE"));
  writeFileSync(join(fonts, "README.txt"), `Noto Sans PBF glyph ranges from https://github.com/protomaps/basemaps-assets (fonts/), SIL Open Font License 1.1 (see LICENSE). Downloaded ${today}; regenerate with tools/basemap/fetch-assets.mjs.\n`);

  const sprites = join(PUB, "sprites", "v4");
  mkdirSync(sprites, { recursive: true });
  for (const f of ["dark.json", "dark.png", "dark@2x.json", "dark@2x.png"]) cpSync(join(src, "sprites", "v4", f), join(sprites, f));
  const lic = await fetch(SPRITES_LICENSE_URL, { headers: { "user-agent": UA } });
  if (!lic.ok) throw new Error(`HTTP ${lic.status} for ${SPRITES_LICENSE_URL}`);
  writeFileSync(join(PUB, "sprites", "LICENSE"), await lic.text());
  writeFileSync(join(PUB, "sprites", "README.txt"), `Spritesheets from https://github.com/protomaps/basemaps-assets (sprites/v4/dark*), derived from the MIT-licensed tangrams/icons (LICENSE in this folder). Downloaded ${today}; regenerate with tools/basemap/fetch-assets.mjs.\n`);
  console.log(`[basemap] assets installed under ${PUB}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
