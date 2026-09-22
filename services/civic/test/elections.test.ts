import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSites, packToRecords, cadenceFor, ELECTION_LIMITATIONS, type Pack } from '../src/elections/normalize.ts';

const html = readFileSync(new URL('./fixtures/detroitvotes-early-2026-09-21.html', import.meta.url), 'utf8');
const pack = JSON.parse(readFileSync(new URL('../src/elections/pack.json', import.meta.url), 'utf8')) as Pack;
const ctx = { election_date: '2026-11-03', verified_on: '2026-09-21', observed_at: '2026-09-21T00:00:00Z', official_url: 'https://detroitvotes.org/early/' };

test('site list: 36 locations, 8 early vote centers, all with addresses and per-election status', () => {
  const sites = parseSites(html, ctx);
  assert.equal(sites.length, 36);
  const evc = sites.filter((s) => s.roles.includes('early_vote_center'));
  assert.equal(evc.length, 8);
  const names = evc.map((s) => s.name);
  for (const n of ['WCCCD Northwest', 'WCCCD Eastern Campus', 'Northwest Activities Center', 'Farwell Recreation Center', 'Department of Elections', 'Detroit City Clerk Office', 'Clark Park', 'Adams Butzel Recreation Complex']) assert.ok(names.includes(n), n);
  assert.equal(sites.filter((s) => s.roles.includes('drop_box')).length, 36);
  const doe = evc.find((s) => s.name === 'Department of Elections')!;
  assert.equal(doe.address_as_published, '2978 W Grand Blvd, Detroit, Michigan 48202, USA');
  assert.equal(doe.status_as_published, 'Early Vote Centers closed for this election');
  assert.equal(doe.lon, null); assert.match(doe.geocode_note, /not geocoded/);
  for (const s of sites) { assert.match(s.address_as_published, /^\d/); assert.deepEqual(s.limitations, ELECTION_LIMITATIONS); assert.equal(s.election_date, '2026-11-03'); }
});
test('pack -> rule and link-out records, every rule dated, cited and limited', () => {
  const recs = packToRecords(pack, '2026-09-21T00:00:00Z');
  const rules = recs.filter((r) => r.record_type === 'rule');
  const links = recs.filter((r) => r.record_type === 'link_out');
  assert.equal(rules.length, pack.rules.length); assert.equal(links.length, pack.link_outs.length);
  for (const r of rules) { assert.equal(r.election_date, '2026-11-03'); assert.match(r.official_url, /^https:\/\//); assert.equal(r.verified_on, '2026-09-21'); assert.deepEqual(r.limitations, ELECTION_LIMITATIONS); }
  const keys = rules.map((r) => (r as { rule_key: string }).rule_key);
  for (const k of ['registration.online_or_mail_deadline', 'registration.in_person_deadline', 'absentee.return_deadline', 'early_voting.dates_and_hours', 'election_day.id_rules']) assert.ok(keys.includes(k), k);
  assert.ok(links.some((l) => (l as { url: string }).url.includes('waynecountymi.gov') && (l as { url: string }).url.includes('August-4th-2026')));
  assert.ok(links.some((l) => (l as { url: string }).url.startsWith('https://mvic.sos.state.mi.us/votehistory/')));
  assert.ok(!JSON.stringify(recs).match(/birth ?date|last name/i), 'no person lookups');
});
test('cadence: daily inside 45 days, weekly otherwise', () => {
  assert.equal(cadenceFor('2026-11-03', new Date('2026-09-01T00:00:00Z')), 'weekly');
  assert.equal(cadenceFor('2026-11-03', new Date('2026-09-21T00:00:00Z')), 'daily'); // 43 days out
  assert.equal(cadenceFor('2026-11-03', new Date('2026-11-04T00:00:00Z')), 'weekly');
});
