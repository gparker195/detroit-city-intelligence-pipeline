import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeRow, guessType, parseBonfireDate, SOLICITATION_LIMITATIONS, type BonfireRow } from '../src/bonfire/normalize.ts';

const rows = JSON.parse(readFileSync(new URL('./fixtures/bonfire-rows.json', import.meta.url), 'utf8')) as BonfireRow[];

test('type guess from ref/title', () => {
  assert.equal(guessType('RFP 26-0001', 'x'), 'RFP');
  assert.equal(guessType('RFQ 26-0002', 'x'), 'RFQ');
  assert.equal(guessType('26-0003', 'Request for Information: Language'), 'RFI');
  assert.equal(guessType('IFB 26-0004', 'Park Improvement Rebid'), 'bid');
  assert.equal(guessType('26-0005', 'Sole Source: Media Relations'), 'sole-source');
  assert.equal(guessType('26-0006', 'HVAC Replacement'), 'unknown');
});
test('date parsing keeps the published offset', () => {
  assert.equal(parseBonfireDate('Sep 30, 2026 3:00 PM EDT'), '2026-09-30T15:00:00-04:00');
  assert.equal(parseBonfireDate('Nov 12, 2026 4:00 PM EST'), '2026-11-12T16:00:00-05:00');
  assert.equal(parseBonfireDate('Oct 1, 2026'), '2026-10-01T00:00:00-04:00');
  assert.equal(parseBonfireDate('bad date'), null);
});
test('normalize rows into Solicitation records', () => {
  const recs = rows.map((r) => normalizeRow(r, '2026-09-21T00:00:00Z'));
  assert.equal(recs.length, 5);
  assert.deepEqual(recs.map((r) => r.type_guess), ['RFP', 'RFQ', 'RFI', 'bid', 'sole-source']);
  assert.equal(recs[0]!.days_left, 9); assert.equal(recs[4]!.days_left, null); assert.equal(recs[4]!.close_at, null);
  assert.equal(recs[4]!.close_at_as_published, 'bad date');
  for (const r of recs) { assert.equal(r.source_id, 'bonfire'); assert.deepEqual(r.limitations, SOLICITATION_LIMITATIONS); assert.match(r.url, /^https:\/\/detroit\.bonfirehub\.com\//); }
});
