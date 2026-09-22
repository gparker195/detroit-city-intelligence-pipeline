import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeHealth, writeHealth } from '../src/health/status.ts';
import { getSource } from '../src/registry/sources.ts';
import { SnapshotStore } from '../src/snapshot/store.ts';

const source = getSource('building-permits'); // daily
const now = new Date('2026-09-21T12:00:00.000Z');

function latest(overrides: Partial<Parameters<typeof computeHealth>[0]['latest'] & object> = {}) {
  return {
    snapshot_id: '2026-09-21T06-00-00.000Z',
    fetched_at: '2026-09-21T06:00:00.000Z',
    layer_last_edit: '2026-09-21T02:23:08.599Z',
    row_count: 801,
    received_count: 801,
    rejected_count: 0,
    complete: true,
    ...overrides,
  };
}

test('fresh, complete snapshot is nominal', () => {
  const h = computeHealth({ source, latest: latest(), lastError: null, now });
  assert.equal(h.status, 'nominal');
  assert.equal(h.freshness, 'fresh');
  assert.equal(h.completeness, 'complete');
  assert.equal(h.age_hours, 6);
  assert.equal(h.stale_after_hours, 36);
});

test('marks stale when the last success is older than cadence plus grace', () => {
  const h = computeHealth({ source, latest: latest({ fetched_at: '2026-09-19T06:00:00.000Z' }), lastError: null, now });
  assert.equal(h.status, 'stale');
  assert.equal(h.freshness, 'stale');
  assert.equal(h.completeness, 'complete', 'completeness axis is untouched by staleness');
  assert.equal(h.age_hours, 54);
  const weekly = computeHealth({ source: getSource('election-precincts-2024'), latest: latest({ fetched_at: '2026-09-19T06:00:00.000Z' }), lastError: null, now });
  assert.equal(weekly.status, 'nominal', 'a weekly source two days old is fresh');
});

test('zero valid rows out of nonzero received is partial, not nominal', () => {
  const h = computeHealth({ source, latest: latest({ row_count: 0, received_count: 801, rejected_count: 801 }), lastError: null, now });
  assert.equal(h.status, 'partial');
  assert.equal(h.completeness, 'partial');
  assert.equal(h.freshness, 'fresh', 'freshness axis is independent of completeness');
  const truncated = computeHealth({ source, latest: latest({ complete: false }), lastError: null, now });
  assert.equal(truncated.status, 'partial');
  const someRejected = computeHealth({ source, latest: latest({ row_count: 800, received_count: 801, rejected_count: 1 }), lastError: null, now });
  assert.equal(someRejected.status, 'partial');
  const empty = computeHealth({ source, latest: latest({ row_count: 0, received_count: 0 }), lastError: null, now });
  assert.equal(empty.status, 'nominal');
  assert.equal(empty.completeness, 'empty');
});

test('loading, unavailable and degraded follow the last attempt', () => {
  assert.equal(computeHealth({ source, latest: null, lastError: null, now }).status, 'loading');
  const failed = { at: '2026-09-21T11:00:00.000Z', message: 'HTTP 503' };
  assert.equal(computeHealth({ source, latest: null, lastError: failed, now }).status, 'unavailable');
  const degraded = computeHealth({ source, latest: latest(), lastError: failed, now });
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.completeness, 'complete');
  const olderError = computeHealth({ source, latest: latest(), lastError: { at: '2026-09-20T11:00:00.000Z', message: 'old' }, now });
  assert.equal(olderError.status, 'nominal', 'an error before the last success does not degrade');
});

test('writeHealth covers every registered source and writes data/health.json', () => {
  const store = new SnapshotStore(mkdtempSync(join(tmpdir(), 'dci-health-')));
  const { file, health } = writeHealth(store, [source, getSource('dlba-for-sale')], now);
  assert.equal(health.sources.length, 2);
  assert.ok(health.sources.every((s) => s.status === 'loading'));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), health);
});
