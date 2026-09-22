/**
 * pnpm run programs [--no-awardees]
 * Weekly cadence. Validates the governed registry, writes data/normalized/programs.ndjson, and
 * fetches the two City awardee layers as points with vintage flags.
 */
import { readFileSync } from 'node:fs';
import { HttpClient } from '../util/http.ts';
import { writeRaw, writeNdjson, updateManifest, rawRef } from '../util/archive.ts';
import { validateRegistry, type ProgramRegistry } from './schema.ts';
import { AWARDEE_ITEMS, fetchAwardeeLayer, normalizeAwardees } from './awardees.ts';

const registryPath = new URL('./registry.json', import.meta.url);
const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as ProgramRegistry;
const errors = validateRegistry(registry);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
const observed_at = new Date().toISOString();
const programs = registry.programs.map((p) => ({ ...p, source_id: 'programs', observed_at }));
const normalized_path = writeNdjson('programs', programs);
const reg = writeRaw('programs', 'registry.json', readFileSync(registryPath), { url: `file://${registryPath.pathname}`, source_updated: registry.registry_version, content_type: 'application/json', fetched_at: observed_at });
const latestVerified = programs.map((p) => p.verified_on).sort().at(-1) ?? null;
updateManifest({ source_id: 'programs', fetched_at: observed_at, source_updated: latestVerified, records: programs.length, normalized_path, raw: [rawRef(reg)], status: 'ok', note: `registry_version ${registry.registry_version}` });
const report: Record<string, unknown> = { source_id: 'programs', records: programs.length, registry_version: registry.registry_version, windows: programs.map((p) => `${p.id}: ${p.application_window}`) };

if (!process.argv.includes('--no-awardees')) {
  const http = new HttpClient({ minIntervalMs: 2000, log: (m) => console.error(m) });
  for (const a of AWARDEE_ITEMS) {
    const got = await fetchAwardeeLayer(http, a.item_id);
    const raws = [
      writeRaw(a.source_id, 'item.json', got.raw.item, { url: `https://www.arcgis.com/sharing/rest/content/items/${a.item_id}?f=json`, source_updated: new Date(got.item.modified).toISOString(), content_type: 'application/json', fetched_at: observed_at }),
      writeRaw(a.source_id, 'layer.json', got.raw.layer, { url: `${got.layer_url}?f=json`, source_updated: null, content_type: 'application/json', fetched_at: observed_at }),
      writeRaw(a.source_id, 'query.geojson', got.raw.query, { url: `${got.layer_url}/query?where=1%3D1&outFields=*&outSR=4326&f=geojson`, source_updated: null, content_type: 'application/geo+json', fetched_at: observed_at }),
    ];
    const points = normalizeAwardees(got.fc, { source_id: a.source_id, program_id: a.program_id, item: got.item, layer: got.layer, layer_url: got.layer_url, observed_at });
    const np = writeNdjson(a.source_id, points);
    updateManifest({ source_id: a.source_id, fetched_at: observed_at, source_updated: points[0]?.vintage.layer_last_edit ?? null, records: points.length, normalized_path: np, raw: raws.map(rawRef), status: 'ok', note: `item "${got.item.title}"; ${points[0]?.vintage.stale_warning ?? ''}` });
    report[a.source_id] = { title: got.item.title, layer_url: got.layer_url, records: points.length, vintage: points[0]?.vintage ?? null, rounds: [...new Set(points.map((p) => p.round))].sort(), example: points[0] ?? null };
  }
}
console.log(JSON.stringify(report, null, 2));
