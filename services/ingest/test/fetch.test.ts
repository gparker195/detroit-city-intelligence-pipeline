import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeatureServiceClient, type Feature } from '../src/arcgis/featureServiceClient.ts';
import { getSource } from '../src/registry/sources.ts';
import { SnapshotStore } from '../src/snapshot/store.ts';
import { fetchSource } from '../src/fetch.ts';
import { buildManifest } from '../src/manifest/manifest.ts';
import { fakeClock, fixture, makeFakeArcgis } from './helpers/fakeArcgis.ts';

const item = fixture('item.dlba-for-sale.json');
const layer = fixture<{ fields: { name: string; type: string }[]; maxRecordCount: number }>('layer.dlba-for-sale.json');
const rows = fixture<{ features: Feature[] }>('query.dlba-for-sale.5rows.json').features;

test('end to end: resolve item, read layer, page, allowlist, snapshot; rerun is a no-op; manifest carries both dates', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dci-fetch-'));
  const store = new SnapshotStore(dataDir);
  const source = getSource('dlba-for-sale');
  const fake = makeFakeArcgis({ item, layer: { ...layer, maxRecordCount: 2 }, features: rows });
  const clock = fakeClock();
  const client = new FeatureServiceClient({ fetchImpl: fake.fetchImpl, sleep: clock.sleep, now: clock.now });

  let t = 0;
  const times = ['2026-09-21T10:00:00.000Z', '2026-09-21T11:00:00.000Z'];
  const first = await fetchSource(client, store, source, { envelope: [-83.15, 42.41, -83.133, 42.426], now: () => new Date(times[t++]!) });
  assert.equal(first.created, true);
  assert.equal(first.meta.row_count, 5);
  assert.equal(first.meta.received_count, 5);
  assert.equal(first.meta.rejected_count, 0);
  assert.equal(first.meta.complete, true);
  assert.equal(first.meta.pages, 3);
  assert.equal(first.meta.key_field, 'parcel_id');
  assert.equal(first.meta.layer_last_edit, '2026-09-21T23:57:26.855Z');
  assert.equal(first.meta.fetched_at, '2026-09-21T10:00:00.000Z');
  assert.deepEqual(first.meta.envelope, [-83.15, 42.41, -83.133, 42.426]);
  assert.equal(first.meta.service_url, 'https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/DLBA_For_Sale/FeatureServer');
  assert.equal(first.requests, 1 + 1 + 3, 'item + layer + three pages');
  assert.ok(fake.requests[0]!.url.startsWith('https://www.arcgis.com/sharing/rest/content/items/e0c4f46a09b9405cb18837e66e85c622'));

  const lines = readFileSync(join(first.dir, 'records.ndjson'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 5);
  const keys = lines.map((l) => JSON.parse(l).key as string);
  assert.deepEqual(keys, [...keys].sort());

  const second = await fetchSource(client, store, source, { envelope: [-83.15, 42.41, -83.133, 42.426], now: () => new Date(times[t++]!) });
  assert.equal(second.created, false);
  assert.equal(second.meta.sha256, first.meta.sha256);
  assert.deepEqual(store.listSnapshots('dlba-for-sale'), [first.meta.snapshot_id]);

  const manifest = buildManifest(store, [source], new Date('2026-09-21T12:00:00.000Z'));
  assert.equal(manifest.sources[0]!.layer_last_edit, '2026-09-21T23:57:26.855Z');
  assert.equal(manifest.sources[0]!.fetched_at, '2026-09-21T10:00:00.000Z');
  assert.equal(manifest.sources[0]!.health, 'nominal');
  assert.equal(manifest.sources[0]!.sha256, first.meta.sha256);
  assert.match(manifest.disclaimer, /Provided AS-IS by the City of Detroit Open Data Portal/);
});

test('a failed fetch records last_error and does not write a snapshot', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dci-fetch-fail-'));
  const store = new SnapshotStore(dataDir);
  const source = getSource('dlba-for-sale');
  const fake = makeFakeArcgis({ item, layer, features: rows, script: { 0: { status: 404, body: 'gone' } } });
  const client = new FeatureServiceClient({ fetchImpl: fake.fetchImpl, sleep: fakeClock().sleep, now: fakeClock().now });
  await assert.rejects(() => fetchSource(client, store, source), /HTTP 404/);
  assert.deepEqual(store.listSnapshots('dlba-for-sale'), []);
});
