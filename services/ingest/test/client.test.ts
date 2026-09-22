import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeatureServiceClient } from '../src/arcgis/featureServiceClient.ts';
import { HttpClient, USER_AGENT } from '../src/util/http.ts';
import { fakeClock, fixture, makeFakeArcgis } from './helpers/fakeArcgis.ts';
import type { Feature } from '../src/arcgis/featureServiceClient.ts';

const layerFixture = fixture<{ fields: { name: string; type: string }[]; maxRecordCount: number }>('layer.dlba-for-sale.json');
const rows = fixture<{ features: Feature[] }>('query.dlba-for-sale.5rows.json').features;
const LAYER_URL = 'https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/DLBA_For_Sale/FeatureServer/0';

function client(fake: ReturnType<typeof makeFakeArcgis>, extra: Record<string, unknown> = {}) {
  const clock = fakeClock();
  // Rate limiting is tested on its own; elsewhere it is lifted so sleeps are backoffs only.
  return { c: new FeatureServiceClient({ fetchImpl: fake.fetchImpl, sleep: clock.sleep, now: clock.now, baseBackoffMs: 10, maxRequestsPerSecond: 1000, ...extra }), clock };
}

test('layer metadata exposes fields, geometry type, page size, lastEditDate and pagination support', async () => {
  const fake = makeFakeArcgis({ item: {}, layer: layerFixture, features: rows });
  const { c } = client(fake);
  const layer = await c.getLayerInfo(LAYER_URL);
  assert.equal(layer.geometryType, 'esriGeometryPoint');
  assert.equal(layer.maxRecordCount, 2000);
  assert.equal(layer.objectIdField, 'ObjectId');
  assert.equal(layer.supportsPagination, true);
  assert.ok(layer.fields.some((f) => f.name === 'parcel_id'));
  assert.equal(typeof layer.lastEditDate, 'number');
  assert.match(layer.lastEditIso ?? '', /^\d{4}-\d{2}-\d{2}T/);
});

test('paging with resultOffset assembles all rows across short pages', async () => {
  assert.equal(rows.length, 5, 'fixture has five recorded rows');
  const fake = makeFakeArcgis({ item: {}, layer: { ...layerFixture, maxRecordCount: 2 }, features: rows });
  const { c } = client(fake);
  const layer = await c.getLayerInfo(LAYER_URL);
  const result = await c.queryAll(layer, { where: "program = 'Own It Now'", envelope: [-83.15, 42.41, -83.133, 42.426] });
  assert.equal(result.features.length, 5);
  assert.equal(result.pages, 3);
  assert.equal(result.complete, true);
  assert.equal(result.method, 'offset');
  assert.deepEqual(
    result.features.map((f) => f.attributes.ObjectId),
    rows.map((f) => f.attributes.ObjectId),
  );
  const queries = fake.requests.filter((r) => r.url.includes('/query')).map((r) => new URL(r.url).searchParams);
  assert.deepEqual(queries.map((q) => q.get('resultOffset')), ['0', '2', '4']);
  assert.equal(queries[0]!.get('where'), "program = 'Own It Now'");
  assert.equal(queries[0]!.get('geometry'), '-83.15,42.41,-83.133,42.426');
  assert.equal(queries[0]!.get('geometryType'), 'esriGeometryEnvelope');
  assert.equal(queries[0]!.get('inSR'), '4326');
  assert.equal(queries[0]!.get('outSR'), '4326');
  assert.equal(queries[0]!.get('returnGeometry'), 'true');
  assert.equal(queries[0]!.get('orderByFields'), 'ObjectId');
});

test('falls back to object-id chunking when the layer does not support pagination', async () => {
  const layer = { ...layerFixture, maxRecordCount: 2, advancedQueryCapabilities: { supportsPagination: false } };
  const fake = makeFakeArcgis({ item: {}, layer, features: rows });
  const { c } = client(fake);
  const result = await c.queryAll(await c.getLayerInfo(LAYER_URL));
  assert.equal(result.method, 'oid-chunks');
  assert.equal(result.features.length, 5);
  assert.equal(result.complete, true);
  assert.ok(fake.requests.some((r) => r.url.includes('returnIdsOnly=true')));
});

test('sends the identifying User-Agent on every request', async () => {
  const fake = makeFakeArcgis({ item: {}, layer: layerFixture, features: rows });
  const { c } = client(fake);
  await c.queryAll(await c.getLayerInfo(LAYER_URL));
  assert.ok(fake.requests.length >= 2);
  for (const r of fake.requests) {
    assert.equal(r.headers['User-Agent'], USER_AGENT);
    assert.equal(r.headers['User-Agent'], 'DetroitCityIntelligence/0.1 (+https://github.com/gparker195/detroit-city-intelligence-pipeline)');
  }
});

test('never exceeds two requests per second', async () => {
  const fake = makeFakeArcgis({ item: {}, layer: { ...layerFixture, maxRecordCount: 1 }, features: rows });
  const clock = fakeClock();
  const starts: number[] = [];
  const timed: typeof fake.fetchImpl = (url, init) => {
    starts.push(clock.now());
    return fake.fetchImpl(url, init);
  };
  const c = new FeatureServiceClient({ fetchImpl: timed, sleep: clock.sleep, now: clock.now });
  await c.queryAll(await c.getLayerInfo(LAYER_URL));
  assert.ok(starts.length >= 6, `expected metadata + 5 pages, got ${starts.length}`);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i]! - starts[i - 1]! >= 500, `requests ${i - 1} and ${i} were ${starts[i]! - starts[i - 1]!} ms apart`);
  }
});

test('retries with backoff on 429 and 5xx, then succeeds', async () => {
  const fake = makeFakeArcgis({
    item: {},
    layer: layerFixture,
    features: rows,
    script: { 0: { status: 429 }, 1: { status: 503 }, 3: { status: 200, body: JSON.stringify({ error: { code: 500, message: 'transient' } }) } },
  });
  const { c, clock } = client(fake, { baseBackoffMs: 100 });
  const layer = await c.getLayerInfo(LAYER_URL); // requests 0 (429), 1 (503), 2 (ok)
  const result = await c.queryAll(layer); // request 3 (ArcGIS 500-in-200), 4 (ok)
  assert.equal(result.features.length, 5);
  assert.equal(fake.requests.length, 5);
  const backoffs = clock.sleeps.filter((ms) => ms >= 100);
  assert.deepEqual(backoffs, [100, 200, 100]);
});

test('gives up after maxAttempts and surfaces the last status', async () => {
  const fake = makeFakeArcgis({ item: {}, layer: layerFixture, features: rows, script: { 0: { status: 500 }, 1: { status: 500 }, 2: { status: 500 } } });
  const http = new HttpClient({ fetchImpl: fake.fetchImpl, sleep: fakeClock().sleep, now: fakeClock().now, maxAttempts: 3, baseBackoffMs: 1 });
  await assert.rejects(() => http.getJson(LAYER_URL + '?f=json'), /HTTP 500/);
  assert.equal(fake.requests.length, 3);
});

test('does not retry a 404', async () => {
  const fake = makeFakeArcgis({ item: {}, layer: layerFixture, features: rows, script: { 0: { status: 404, body: 'nope' } } });
  const http = new HttpClient({ fetchImpl: fake.fetchImpl, sleep: fakeClock().sleep, now: fakeClock().now });
  await assert.rejects(() => http.getJson(LAYER_URL + '?f=json'), /HTTP 404/);
  assert.equal(fake.requests.length, 1);
});
