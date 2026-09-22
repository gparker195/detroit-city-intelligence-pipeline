#!/usr/bin/env node
/**
 * Keyless Detroit-metro basemap build.
 *
 * 1. Discover the latest daily Protomaps planet build. The listing that
 *    maps.protomaps.com/builds reads is https://build-metadata.protomaps.dev/builds.json
 *    (verified 2026-09-22; the bare https://build.protomaps.com/ root returns 404).
 *    Fallback: HEAD-probe https://build.protomaps.com/YYYYMMDD.pmtiles backwards from today.
 * 2. Download the `pmtiles` CLI (go-pmtiles, BSD-3-Clause) for this platform (macOS arm64
 *    or Linux x86_64, the GitHub Actions runner) from the GitHub release. The release
 *    publishes no checksum file (verified 2026-09-22 for v1.31.2), so we record the sha256
 *    of what we downloaded in the meta file and pin the version + a known sha256 per asset
 *    below; a mismatch is reported, not fatal, unless PMTILES_STRICT_CHECKSUM=1.
 * 3. `pmtiles extract <planet> detroit-metro.pmtiles --bbox=... --maxzoom=15`
 *    (HTTP range requests only; the 138 GB planet is never downloaded).
 *    If the result exceeds 200 MB, rebuild at maxzoom 14 and note it.
 * 4. Write detroit-metro.meta.json (build date, source URL, sha256, size, timings).
 * 5. Copy the archive to tools/basemap/public/basemap/ (or $DCI_BASEMAP_DIR), the folder
 *    scripts/publish.sh reads; the .pmtiles is gitignored and published as a release asset.
 *
 * Data: OpenStreetMap contributors, ODbL. Rendered Produced Work only; never merge into evidence.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "detroit-metro.pmtiles");
const META = join(HERE, "detroit-metro.meta.json");
const PUBLIC_DIR = process.env.DCI_BASEMAP_DIR ? resolve(process.env.DCI_BASEMAP_DIR) : join(HERE, "public", "basemap");
const BIN_DIR = join(HERE, "bin");

export const BBOX = [-83.6, 42.1, -82.8, 42.6]; // W,S,E,N: Detroit metro incl. Livernois/McNichols and downtown
const SIZE_LIMIT = 200 * 1024 * 1024;
const BUILDS_JSON = "https://build-metadata.protomaps.dev/builds.json";
const BUILD_BASE = "https://build.protomaps.com/";
const PMTILES_VERSION = "1.31.2";
// Release assets per platform, with the sha256 of each archive as downloaded 2026-09-22
// (go-pmtiles publishes no checksum file). Linux x86_64 is the GitHub Actions runner.
const PMTILES_ASSETS = {
  "darwin-arm64": { asset: `go-pmtiles-${PMTILES_VERSION}_Darwin_arm64.zip`, sha256: "40528f7f616fcbf91207cd48c8fc023d213f6d86c0cbf1f748732803d1880f3d" },
  "linux-x64": { asset: `go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz`, sha256: "3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f" },
};
const PLATFORM = `${process.platform}-${process.arch}`;
const PMTILES_ASSET = PMTILES_ASSETS[PLATFORM]?.asset ?? null;
const PMTILES_ZIP_SHA256 = PMTILES_ASSETS[PLATFORM]?.sha256 ?? null;
const PMTILES_URL = `https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/${PMTILES_ASSET}`;
const UA = "DetroitCityIntelligence-basemap-build/0.1 (+https://github.com/gparker195/detroit-city-intelligence-pipeline)";

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
let maxzoom = Number(arg("--maxzoom", "15"));
const forcedBuild = arg("--build", null);
const skipCopy = args.includes("--skip-copy");

function log(...m) { console.log("[basemap]", ...m); }

async function sha256(file) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}

async function discoverLatestBuild() {
  if (forcedBuild) return { key: `${forcedBuild}.pmtiles`, source: "forced" };
  try {
    const res = await fetch(BUILDS_JSON, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const builds = (await res.json()).filter((b) => /^\d{8}\.pmtiles$/.test(b.key));
    builds.sort((a, b) => (a.key < b.key ? 1 : -1));
    if (builds.length) return { ...builds[0], source: BUILDS_JSON };
    throw new Error("no builds in listing");
  } catch (e) {
    log(`builds.json unavailable (${e.message}); probing ${BUILD_BASE}YYYYMMDD.pmtiles`);
  }
  const d = new Date();
  for (let i = 0; i < 14; i++) {
    const key = d.toISOString().slice(0, 10).replaceAll("-", "") + ".pmtiles";
    const res = await fetch(BUILD_BASE + key, { method: "HEAD", headers: { "user-agent": UA } });
    if (res.ok) return { key, size: Number(res.headers.get("content-length")), uploaded: res.headers.get("last-modified"), source: "HEAD probe" };
    d.setUTCDate(d.getUTCDate() - 1);
  }
  throw new Error("could not find a daily build in the last 14 days");
}

async function ensurePmtilesCli() {
  const bin = join(BIN_DIR, "pmtiles");
  if (existsSync(bin)) {
    const v = spawnSync(bin, ["version"], { encoding: "utf8" });
    if (v.status === 0 && v.stdout.includes(PMTILES_VERSION)) return bin;
  }
  if (!PMTILES_ASSET) {
    throw new Error(`no pinned go-pmtiles asset for ${PLATFORM}; install go-pmtiles ${PMTILES_VERSION} into ${BIN_DIR} (known: ${Object.keys(PMTILES_ASSETS).join(", ")})`);
  }
  mkdirSync(BIN_DIR, { recursive: true });
  const archive = join(BIN_DIR, PMTILES_ASSET);
  log(`downloading ${PMTILES_URL}`);
  const res = await fetch(PMTILES_URL, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`pmtiles download failed: HTTP ${res.status}`);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  const sum = await sha256(archive);
  if (sum !== PMTILES_ZIP_SHA256) {
    const msg = `pmtiles archive sha256 ${sum} != pinned ${PMTILES_ZIP_SHA256}`;
    if (process.env.PMTILES_STRICT_CHECKSUM === "1") throw new Error(msg);
    log(`WARNING: ${msg} (go-pmtiles publishes no checksum; update the pin after verifying the release)`);
  } else log("pmtiles archive sha256 matches pinned value");
  const extract = PMTILES_ASSET.endsWith(".zip")
    ? spawnSync("unzip", ["-o", "-q", archive, "pmtiles", "-d", BIN_DIR], { stdio: "inherit" })
    : spawnSync("tar", ["-xzf", archive, "-C", BIN_DIR, "pmtiles"], { stdio: "inherit" });
  if (extract.status !== 0) throw new Error("extracting the pmtiles CLI failed");
  chmodSync(bin, 0o755);
  return bin;
}

function runExtract(bin, planetUrl, mz) {
  if (existsSync(OUT)) rmSync(OUT);
  const t0 = Date.now();
  log(`pmtiles extract ${planetUrl} -> ${OUT} bbox=${BBOX.join(",")} maxzoom=${mz}`);
  const r = spawnSync(bin, ["extract", planetUrl, OUT, `--bbox=${BBOX.join(",")}`, `--maxzoom=${mz}`], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`pmtiles extract exited ${r.status}`);
  return (Date.now() - t0) / 1000;
}

async function main() {
  const build = await discoverLatestBuild();
  const buildDate = build.key.slice(0, 8);
  const planetUrl = BUILD_BASE + build.key;
  log(`latest build: ${build.key} (${build.source})`);
  const bin = await ensurePmtilesCli();
  const cliVersion = spawnSync(bin, ["version"], { encoding: "utf8" }).stdout.trim();

  const notes = [];
  let seconds = runExtract(bin, planetUrl, maxzoom);
  let size = statSync(OUT).size;
  if (size > SIZE_LIMIT && maxzoom > 14) {
    notes.push(`maxzoom ${maxzoom} extract was ${(size / 1048576).toFixed(1)} MB (> 200 MB); rebuilt at maxzoom 14`);
    log(notes.at(-1));
    maxzoom = 14;
    seconds += runExtract(bin, planetUrl, maxzoom);
    size = statSync(OUT).size;
  }

  const meta = {
    name: "detroit-metro.pmtiles",
    buildDate: `${buildDate.slice(0, 4)}-${buildDate.slice(4, 6)}-${buildDate.slice(6, 8)}`,
    sourceUrl: planetUrl,
    sourceListing: build.source,
    sourceUploaded: build.uploaded ?? null,
    sourceSizeBytes: build.size ?? null,
    sourceTilesetVersion: build.version ?? null,
    bbox: BBOX,
    maxzoom,
    sizeBytes: size,
    sha256: await sha256(OUT),
    extractSeconds: Number(seconds.toFixed(1)),
    pmtilesCli: cliVersion,
    pmtilesCliUrl: PMTILES_URL,
    pmtilesCliZipSha256: PMTILES_ZIP_SHA256,
    builtAt: new Date().toISOString(),
    license: "Data © OpenStreetMap contributors (ODbL). Protomaps basemap style CC0. Rendered Produced Work only; never merged into the evidence database.",
    attribution: "© OpenStreetMap contributors",
    notes,
  };
  writeFileSync(META, JSON.stringify(meta, null, 2) + "\n");
  log(`wrote ${META}`);

  if (!skipCopy) {
    mkdirSync(PUBLIC_DIR, { recursive: true });
    copyFileSync(OUT, join(PUBLIC_DIR, "detroit-metro.pmtiles"));
    copyFileSync(META, join(PUBLIC_DIR, "detroit-metro.meta.json"));
    log(`copied to ${PUBLIC_DIR}`);
  }
  log(`done: build ${meta.buildDate}, ${(size / 1048576).toFixed(1)} MB, maxzoom ${maxzoom}, ${seconds.toFixed(1)} s`);
}

main().catch((e) => { console.error("[basemap] FAILED:", e.message); process.exit(1); });
