import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRecords, SnapshotStore, serializeRecords, sha256, chooseKeyField, type SnapshotRecord } from '../src/snapshot/store.ts';
import { fixture } from './helpers/fakeArcgis.ts';
import type { Feature } from '../src/arcgis/featureServiceClient.ts';

const rows = fixture<{ features: Feature[] }>('query.dlba-for-sale.5rows.json').features;
const ALLOWED = ['address', 'parcel_id', 'program', 'listing_date', 'ObjectId', 'longitude', 'latitude'];

function baseMeta(fetchedAt: string) {
  return {
    source_id: 'dlba-for-sale',
    item_id: 'e0c4f46a09b9405cb18837e66e85c622',
    service_url: 'https://example.invalid/FeatureServer',
    layer_url: 'https://example.invalid/FeatureServer/0',
    fetched_at: fetchedAt,
    layer_last_edit: '2026-09-21T23:57:26.855Z',
    layer_last_edit_ms: 1790035046855,
    complete: true,
    where: null,
    envelope: null,
    key_field: 'parcel_id',
    field_allowlist: ALLOWED,
    fields_dropped: [],
    pages: 1,
    paging_method: 'offset',
    geometry_type: 'esriGeometryPoint',
  };
}

test('records are sorted by stable key and the hash is independent of input order', () => {
  const shuffled = [...rows].reverse();
  const a = prepareRecords(rows, 'parcel_id', ALLOWED).records;
  const b = prepareRecords(shuffled, 'parcel_id', ALLOWED).records;
  assert.deepEqual(a.map((r) => r.key), [...a.map((r) => r.key)].sort());
  assert.equal(sha256(serializeRecords(a)), sha256(serializeRecords(b)));
  // Canonical JSON: attribute key order does not affect the hash either.
  const reordered: SnapshotRecord[] = a.map((r) => ({ geometry: r.geometry, attributes: Object.fromEntries(Object.entries(r.attributes).reverse()), key: r.key }));
  assert.equal(sha256(serializeRecords(a)), sha256(serializeRecords(reordered)));
});

test('rows without a stable key are rejected and counted; duplicate keys stay distinct', () => {
  const features: Feature[] = [
    { attributes: { parcel_id: 'B', ObjectId: 1 } },
    { attributes: { parcel_id: null, ObjectId: 2 } },
    { attributes: { parcel_id: 'A', ObjectId: 3 } },
    { attributes: { parcel_id: 'A', ObjectId: 4 } },
    { attributes: { ObjectId: 5 } },
  ];
  const { records, rejected } = prepareRecords(features, 'parcel_id', ['parcel_id', 'ObjectId']);
  assert.equal(rejected.length, 2);
  assert.deepEqual(records.map((r) => r.key), ['A', 'A#2', 'B']);
  assert.equal(chooseKeyField(['record_id', 'OBJECTID', 'ObjectId'], ['address', 'ObjectId']), 'ObjectId');
  assert.throws(() => chooseKeyField(['record_id'], ['address']), /stable key/);
});

test('identical data yields the same sha256 and creates no new snapshot; --force does', () => {
  const store = new SnapshotStore(mkdtempSync(join(tmpdir(), 'dci-store-')));
  const records = prepareRecords(rows, 'parcel_id', ALLOWED).records;
  const first = store.write({ ...baseMeta('2026-09-21T10:00:00.000Z'), records, rejected_count: 0 });
  assert.equal(first.created, true);
  assert.ok(existsSync(join(first.dir, 'records.ndjson')));
  assert.ok(existsSync(join(first.dir, 'meta.json')));
  assert.equal(first.meta.snapshot_id, '2026-09-21T10-00-00.000Z');
  assert.equal(store.readLatest('dlba-for-sale')?.snapshot_id, first.meta.snapshot_id);

  const again = store.write({ ...baseMeta('2026-09-21T11:00:00.000Z'), records: prepareRecords([...rows].reverse(), 'parcel_id', ALLOWED).records, rejected_count: 0 });
  assert.equal(again.created, false);
  assert.equal(again.meta.sha256, first.meta.sha256);
  assert.equal(again.meta.snapshot_id, first.meta.snapshot_id);
  assert.deepEqual(store.listSnapshots('dlba-for-sale'), [first.meta.snapshot_id]);

  const forced = store.write({ ...baseMeta('2026-09-21T12:00:00.000Z'), records, rejected_count: 0 }, { force: true });
  assert.equal(forced.created, true);
  assert.equal(forced.meta.sha256, first.meta.sha256);
  assert.deepEqual(store.listSnapshots('dlba-for-sale'), [first.meta.snapshot_id, forced.meta.snapshot_id]);

  const changed = store.write({ ...baseMeta('2026-09-21T13:00:00.000Z'), records: records.slice(1), rejected_count: 1 });
  assert.equal(changed.created, true);
  assert.notEqual(changed.meta.sha256, first.meta.sha256);
  assert.equal(changed.meta.row_count, 4);
  assert.equal(changed.meta.received_count, 5);
  const meta = JSON.parse(readFileSync(join(changed.dir, 'meta.json'), 'utf8'));
  assert.equal(meta.sha256, sha256(readFileSync(join(changed.dir, 'records.ndjson'), 'utf8')));
  assert.equal(store.readLatest('dlba-for-sale')?.snapshot_id, changed.meta.snapshot_id);
});
