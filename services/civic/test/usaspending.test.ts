import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizePages, AGREEMENT_LIMITATIONS } from '../src/usaspending/normalize.ts';
import { buildRequest, fiscalYearRange, currentFiscalYear, fetchAwards, type SearchResponse } from '../src/usaspending/client.ts';
import { HttpClient } from '../src/util/http.ts';

const page = JSON.parse(readFileSync(new URL('./fixtures/usaspending-page.json', import.meta.url), 'utf8')) as SearchResponse;

test('fiscal years', () => {
  assert.deepEqual(fiscalYearRange(2026), { start_date: '2025-10-01', end_date: '2026-09-30' });
  assert.equal(currentFiscalYear(new Date('2026-09-21T12:00:00Z')), 2026);
  assert.equal(currentFiscalYear(new Date('2026-10-01T12:00:00Z')), 2027);
});
test('request shape: Detroit place of performance, award groups, fields', () => {
  const r = buildRequest(2026, 'grants', 2, 100);
  assert.deepEqual(r.filters.place_of_performance_locations, [{ country: 'USA', state: 'MI', city: 'Detroit' }]);
  assert.deepEqual(r.filters.award_type_codes, ['02', '03', '04', '05']);
  assert.ok(r.fields.includes('place_of_performance'));
  assert.equal(r.page, 2);
});
test('normalize: Agreement records, duplicate award ids dropped, limitation attached', () => {
  const { records, duplicates } = normalizePages([{ fy: 2026, group: 'contracts', response: page }], '2026-09-21T00:00:00Z');
  assert.equal(duplicates, 1);
  assert.equal(records.length, 2);
  const gm = records.find((r) => r.recipient === 'GM DEFENSE LLC')!;
  assert.equal(gm.agreement_id, 'CONT_AWD_W912CH26F0209_9700_W56HZV20D0066_9700');
  assert.equal(gm.level, 'federal'); assert.equal(gm.amount, 26690.4); assert.equal(gm.agency, 'Department of Defense'); assert.equal(gm.start, '2026-03-24'); assert.equal(gm.end, '2026-05-06');
  assert.equal(gm.source_id, 'usaspending'); assert.deepEqual(gm.limitations, AGREEMENT_LIMITATIONS);
  const cdbg = records.find((r) => r.recipient === 'CITY OF DETROIT')!;
  assert.equal(cdbg.end, null); assert.equal(cdbg.place_of_performance?.['city_name'], 'DETROIT');
  assert.deepEqual(normalizePages([{ fy: 2026, group: 'contracts', response: { results: [{ 'Award ID': 'X', generated_internal_id: 'Y', 'Place of Performance City Code': 'DETROIT', 'Place of Performance State Code': 'MI' }] } }], 't').records[0]!.place_of_performance, { city_code: 'DETROIT', state_code: 'MI' });
});
test('paging stops at cap and hasNext', async () => {
  const bodies: string[] = [];
  const http = new HttpClient({ ignoreRobots: true, sleep: async () => {}, fetchImpl: async (_u, init) => { bodies.push(init?.body ?? ''); const p = JSON.parse(init!.body!).page as number; const r = { ...page, page_metadata: { page: p, hasNext: p < 3 } }; return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(r), arrayBuffer: async () => new ArrayBuffer(0) }; } });
  const pages = await fetchAwards(http, { fiscalYears: [2026], groups: ['contracts'], capPerQuery: 5, pageSize: 3 });
  assert.equal(pages.length, 2); // 3 + 3 >= 5
  assert.equal(JSON.parse(bodies[1]!).limit, 2); // second page asks only for the remainder
});
