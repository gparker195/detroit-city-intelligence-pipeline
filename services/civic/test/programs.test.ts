import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRegistry, validateProgram, PROGRAM_LIMITATION, type ProgramRegistry } from '../src/programs/schema.ts';
import { normalizeAwardees, AWARDEE_LIMITATIONS } from '../src/programs/awardees.ts';

const registry = JSON.parse(readFileSync(new URL('../src/programs/registry.json', import.meta.url), 'utf8')) as ProgramRegistry;

test('registry.json validates and covers the required programs', () => {
  assert.deepEqual(validateRegistry(registry), []);
  const ids = registry.programs.map((p) => p.id);
  for (const id of ['motor-city-match', 'motor-city-re-store', 'green-grocer', 'nextup313', 'detroit-startup-fund', 'detroit-legacy-business-project', 'detroit-means-business', 'detroit-development-fund', 'prosperus-detroit', 'pure-michigan-business-connect', 'detroit-business-certification', 'bonfire-vendor-registration', 'sigma-vss', 'sam-gov-registration']) assert.ok(ids.includes(id), id);
  const cert = registry.programs.find((p) => p.id === 'detroit-business-certification')!;
  const types = (cert.details as { certification_types: { code: string }[] }).certification_types;
  assert.equal(types.length, 8);
  assert.deepEqual((cert.details as { one_taxable_year_exceptions: string[] }).one_taxable_year_exceptions.length, 3);
  for (const p of registry.programs) { assert.equal(p.verified_on, '2026-09-21'); assert.ok(p.limitations.includes(PROGRAM_LIMITATION)); }
});
test('validator rejects bad records', () => {
  const bad = { id: 'Bad Id', name: 'x', administrator: 'y', kind: 'gift', eligibility_summary_as_published: 'z', award_range: 5, application_window: 'soon', geography_rule: 'g', official_url: 'http://x', verified_on: '9/21/26', limitations: [] };
  const errs = validateProgram(bad);
  for (const k of ['id', 'kind', 'award_range', 'application_window', 'official_url', 'verified_on', 'limitations']) assert.ok(errs.some((e) => e.includes(`.${k}`)), k);
  assert.ok(validateRegistry({ registry_version: 'v', programs: [registry.programs[0], registry.programs[0]] }).some((e) => /duplicate/.test(e)));
});
test('awardee points carry vintage flags and no person fields', () => {
  const fc = { features: [{ id: 7, geometry: { type: 'Point', coordinates: [-83.1, 42.4] }, properties: { round: 'Round 1', business: 'Example Shop', business_address: '1 Main St', description: 'd', url: 'https://example.org', parcelno: '01000001.' } }] };
  const pts = normalizeAwardees(fc, { source_id: 'mcm-cash-awardees', program_id: 'motor-city-match', item: { title: 'MCM', url: 'u', modified: 1604698860000, created: 1562599044000 }, layer: { editingInfo: { lastEditDate: 1562599071223 } }, layer_url: 'https://services2.arcgis.com/x/0', observed_at: '2026-09-21T00:00:00Z' });
  assert.equal(pts.length, 1);
  assert.equal(pts[0]!.awardee_id, 'mcm-cash-awardees:7'); assert.equal(pts[0]!.lon, -83.1);
  assert.equal(pts[0]!.vintage.layer_last_edit, '2019-07-08T15:17:51.223Z'); assert.match(pts[0]!.vintage.stale_warning, /2019-07-08/);
  assert.deepEqual(pts[0]!.limitations, AWARDEE_LIMITATIONS);
});
