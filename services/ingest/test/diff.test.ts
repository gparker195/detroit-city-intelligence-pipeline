import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffRecords, ChangeStore, diffLatest, isIgnoredField } from '../src/diff/engine.ts';
import { SnapshotStore, type SnapshotMeta, type SnapshotRecord } from '../src/snapshot/store.ts';

function meta(snapshotId: string, fetchedAt: string, keyField = 'record_id'): SnapshotMeta {
  return {
    snapshot_id: snapshotId,
    source_id: 'building-permits',
    item_id: '86d47e86062e4beeb19344eb125b75d2',
    service_url: 'https://example.invalid/FeatureServer',
    layer_url: 'https://example.invalid/FeatureServer/0',
    fetched_at: fetchedAt,
    layer_last_edit: '2026-09-21T02:23:08.599Z',
    layer_last_edit_ms: 1789978988599,
    row_count: 0,
    received_count: 0,
    rejected_count: 0,
    complete: true,
    sha256: '',
    where: null,
    envelope: null,
    key_field: keyField,
    field_allowlist: [],
    fields_dropped: [],
    pages: 1,
    paging_method: 'offset',
    geometry_type: 'esriGeometryPoint',
  };
}

const rec = (key: string, attributes: Record<string, unknown>, geometry: unknown = { x: -83.14, y: 42.418 }): SnapshotRecord => ({
  key,
  attributes: { record_id: key, ...attributes },
  geometry,
});

test('diff detects added, removed and modified rows with per-field changes', () => {
  const before = [
    rec('BLD2026-001', { permit_type: 'Alteration', issued_date: null, ObjectId: 1, Shape__Length: 1 }),
    rec('BLD2026-002', { permit_type: 'New', issued_date: '2026-09-01', ObjectId: 2 }),
    rec('BLD2026-003', { permit_type: 'Demo', issued_date: null, ObjectId: 3 }),
  ];
  const after = [
    rec('BLD2026-001', { permit_type: 'Alteration', issued_date: '2026-09-20', ObjectId: 11, Shape__Length: 2 }),
    rec('BLD2026-002', { permit_type: 'New', issued_date: '2026-09-01', ObjectId: 12 }, { x: -83.141, y: 42.418 }),
    rec('BLD2026-004', { permit_type: 'Sign', issued_date: null, ObjectId: 14 }),
  ];
  const summary = diffRecords(
    { meta: meta('2026-09-20T06-00-00.000Z', '2026-09-20T06:00:00.000Z'), records: before },
    { meta: meta('2026-09-21T06-00-00.000Z', '2026-09-21T06:00:00.000Z'), records: after },
  );
  assert.equal(summary.added, 1);
  assert.equal(summary.removed, 1);
  assert.equal(summary.modified_rows, 2);
  assert.deepEqual(summary.ignored_fields, ['ObjectId', 'Shape__Length']);

  const byKind = (kind: string) => summary.changes.filter((c) => c.kind === kind);
  assert.deepEqual(byKind('added').map((c) => c.entity_key), ['BLD2026-004']);
  assert.deepEqual(byKind('removed').map((c) => c.entity_key), ['BLD2026-003']);
  const modified = byKind('modified').map((c) => [c.entity_key, c.field, c.old, c.new]);
  assert.deepEqual(modified, [
    ['BLD2026-001', 'issued_date', null, '2026-09-20'],
    ['BLD2026-002', 'geometry', { x: -83.14, y: 42.418 }, { x: -83.141, y: 42.418 }],
  ]);
  for (const c of summary.changes) {
    assert.equal(c.source_id, 'building-permits');
    assert.equal(c.observed_at, '2026-09-21T06:00:00.000Z');
    assert.equal(c.previous_snapshot_id, '2026-09-20T06-00-00.000Z');
    assert.equal(c.snapshot_id, '2026-09-21T06-00-00.000Z');
    assert.match(c.change_id, /^[0-9a-f]{32}$/);
  }
  assert.equal(new Set(summary.changes.map((c) => c.change_id)).size, summary.changes.length);
});

test('ObjectId churn is a real change only when ObjectId is the stable key', () => {
  assert.equal(isIgnoredField('ObjectId', 'record_id'), true);
  assert.equal(isIgnoredField('OBJECTID', 'parcel_id'), true);
  assert.equal(isIgnoredField('Shape__Area', 'OBJECTID'), true);
  assert.equal(isIgnoredField('ObjectId', 'ObjectId'), false);
  assert.equal(isIgnoredField('permit_type', 'record_id'), false);
});

test('identical snapshots produce no changes; diffLatest writes the change file and reports no previous', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dci-diff-'));
  const store = new SnapshotStore(dataDir);
  const changes = new ChangeStore(dataDir);
  assert.deepEqual(diffLatest(store, changes, 'building-permits'), { status: 'no-snapshot', source_id: 'building-permits' });

  const { snapshot_id: _a, sha256: _b, row_count: _c, received_count: _d, rejected_count: _e, ...base } = meta('x', '2026-09-20T06:00:00.000Z');
  const records = [rec('BLD2026-001', { permit_type: 'Alteration', ObjectId: 1 })];
  store.write({ ...base, records, rejected_count: 0 });
  const only = diffLatest(store, changes, 'building-permits');
  assert.equal(only.status, 'no-previous');

  store.write({ ...base, fetched_at: '2026-09-21T06:00:00.000Z', records: [rec('BLD2026-001', { permit_type: 'Alteration', ObjectId: 999 })], rejected_count: 0 });
  const outcome = diffLatest(store, changes, 'building-permits');
  assert.equal(outcome.status, 'diffed');
  if (outcome.status !== 'diffed') return;
  assert.equal(outcome.summary.changes.length, 0, 'ObjectId churn alone is not a change');
  assert.equal(readFileSync(outcome.file, 'utf8'), '');
  assert.match(outcome.file, /data|dci-diff-.*\/changes\/building-permits\/2026-09-21T06-00-00\.000Z\.ndjson$/);
});

test('fields excluded by the current allowlist never enter a change row, even when an older snapshot carried them', () => {
  const meta = (id: string, allowlist: string[]) =>
    ({ snapshot_id: id, source_id: 'x', key_field: 'record_id', fetched_at: `2026-09-2${id}T00:00:00.000Z`, field_allowlist: allowlist }) as unknown as Parameters<typeof diffRecords>[0]['meta'];
  const before = { meta: meta('1', ['record_id', 'status', 'owner_name']), records: [
    { key: 'a', attributes: { record_id: 'a', status: 'open', owner_name: 'MUST NOT SURVIVE' }, geometry: null },
    { key: 'b', attributes: { record_id: 'b', status: 'open', owner_name: 'MUST NOT SURVIVE' }, geometry: null },
  ] };
  const after = { meta: meta('2', ['record_id', 'status']), records: [
    { key: 'a', attributes: { record_id: 'a', status: 'closed' }, geometry: null },
    { key: 'c', attributes: { record_id: 'c', status: 'open', owner_name: 'LEAKED IN SNAPSHOT' }, geometry: null },
  ] };
  const summary = diffRecords(before, after);
  assert.ok(!JSON.stringify(summary.changes).includes('owner_name'), 'no change row names the excluded field');
  assert.ok(!JSON.stringify(summary.changes).includes('MUST NOT SURVIVE'));
  assert.ok(!JSON.stringify(summary.changes).includes('LEAKED'));
  assert.deepEqual(summary.ignored_fields, ['owner_name']);
  assert.equal(summary.added, 1);
  assert.equal(summary.removed, 1);
  assert.equal(summary.modified_rows, 1);
  assert.deepEqual(summary.changes.filter((c) => c.kind === 'modified').map((c) => c.field), ['status']);
});
