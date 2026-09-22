/**
 * One fetch of one registered source into the snapshot store.
 *
 *   resolve item → layer metadata → (skip when lastEditDate unchanged) → allowlist → page all
 *   rows → scope filter → prepare (key, sort, reject) → write snapshot (skipped when the sha256
 *   matches the latest one, unless force)
 *
 * Scoping (PRD "Named scenario", study area = official SNF polygon):
 *   envelope   legacy bbox filter, server-side
 *   polygon    polygon/line layers: server-side polygon intersect (POST)
 *   buffer     point feeds: attribute bbox on longitude/latitude (the City's point layers often
 *              publish rows without geometry, so a spatial filter under-counts by ~99%), then an
 *              exact point-in-(polygon + buffer) test here before anything is written
 */

import { FeatureServiceClient, type Envelope, type Feature, type LayerInfo } from './arcgis/featureServiceClient.ts';
import { computeAllowedFields, resolveServiceUrl, type SourceDefinition } from './registry/sources.ts';
import { chooseKeyField, prepareRecords, SnapshotStore, type SnapshotMeta, type SpatialScope } from './snapshot/store.ts';
import { expandEnvelope, featurePoint, pointWithinBuffer, ringsBbox, type Ring } from './util/geo.ts';

export interface PolygonScope {
  kind: 'polygon';
  study_area_id: string;
  rings: Ring[];
}

export interface BufferScope {
  kind: 'buffer';
  study_area_id: string;
  rings: Ring[];
  buffer_m: number;
}

export type FetchScopeOption = { kind: 'envelope'; envelope: Envelope } | PolygonScope | BufferScope | { kind: 'none' };

export interface FetchOptions {
  /** Legacy: an envelope. Ignored when `scope` is set. */
  envelope?: Envelope | null;
  scope?: FetchScopeOption;
  where?: string | null;
  force?: boolean;
  /** When true (default), a layer whose lastEditDate equals the latest snapshot's is not re-fetched. */
  skipIfUnchanged?: boolean;
  /** Injected clock so tests and reruns are deterministic. */
  now?: () => Date;
  log?: (message: string) => void;
}

export interface FetchResult {
  created: boolean;
  /** 'unchanged' when the lastEditDate check short-circuited the fetch. */
  skipped: 'unchanged' | null;
  meta: SnapshotMeta;
  dir: string;
  layer: LayerInfo;
  requests: number;
  /** Rows dropped by the exact point-in-buffer test (buffer scope only). */
  out_of_scope: number;
}

function describeScope(scope: FetchScopeOption): SpatialScope {
  switch (scope.kind) {
    case 'none':
      return { kind: 'none' };
    case 'envelope':
      return { kind: 'envelope', envelope: scope.envelope };
    case 'polygon':
      return { kind: 'polygon', study_area_id: scope.study_area_id, bbox: ringsBbox(scope.rings), buffer_m: 0 };
    case 'buffer':
      return { kind: 'buffer', study_area_id: scope.study_area_id, bbox: ringsBbox(scope.rings), buffer_m: scope.buffer_m };
  }
}

function metaScope(meta: SnapshotMeta): SpatialScope {
  if (meta.spatial) return meta.spatial;
  return meta.envelope ? { kind: 'envelope', envelope: meta.envelope } : { kind: 'none' };
}

function sameScope(a: SpatialScope, b: SpatialScope): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function lonLatFieldNames(layer: LayerInfo): { lon: string; lat: string } | null {
  const lon = layer.fields.find((f) => f.name.toLowerCase() === 'longitude')?.name;
  const lat = layer.fields.find((f) => f.name.toLowerCase() === 'latitude')?.name;
  return lon && lat ? { lon, lat } : null;
}

export async function fetchSource(
  client: FeatureServiceClient,
  store: SnapshotStore,
  source: SourceDefinition,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const requestsBefore = client.http.requestCount;
  const scope: FetchScopeOption = options.scope ?? (options.envelope ? { kind: 'envelope', envelope: options.envelope } : { kind: 'none' });
  const spatial = describeScope(scope);

  const resolved = await resolveServiceUrl(client.http, source);
  if (!resolved.matches_expected) {
    log(`warning: ${source.id} resolved to ${resolved.service_url}, expected service "${source.expected_service}" (item may have moved)`);
  }
  log(`${source.id}: ${resolved.item_title} -> ${resolved.layer_url}`);

  const layer = await client.getLayerInfo(resolved.layer_url);
  const where = options.where && options.where.trim() ? options.where.trim() : null;

  // Cheap check first: same lastEditDate, same scope and where → the data cannot have changed.
  const latest = store.readLatest(source.id);
  if (latest && !options.force && (options.skipIfUnchanged ?? true) && layer.lastEditIso !== null && latest.layer_last_edit === layer.lastEditIso) {
    const latestMeta = store.readMeta(source.id, latest.snapshot_id);
    if (sameScope(metaScope(latestMeta), spatial) && (latestMeta.where ?? null) === where && latestMeta.complete) {
      log(`${source.id}: layer lastEditDate ${layer.lastEditIso} unchanged since snapshot ${latest.snapshot_id}; skipping fetch`);
      return {
        created: false,
        skipped: 'unchanged',
        meta: latestMeta,
        dir: store.snapshotDir(source.id, latest.snapshot_id),
        layer,
        requests: client.http.requestCount - requestsBefore,
        out_of_scope: 0,
      };
    }
  }

  const allowed = computeAllowedFields(layer.fields, source.field_allowlist, source.keep_only);
  const dropped = layer.fields.map((f) => f.name).filter((name) => !allowed.includes(name));
  const keyField = chooseKeyField(source.stable_key, layer.fields.map((f) => f.name));
  if (!allowed.includes(keyField)) throw new Error(`stable key ${keyField} is excluded by the allowlist for ${source.id}`);
  log(`${source.id}: layer "${layer.name}" ${layer.geometryType ?? 'no geometry'}, maxRecordCount ${layer.maxRecordCount}, lastEdit ${layer.lastEditIso ?? 'n/a'}, key ${keyField}, dropped [${dropped.join(', ')}]`);

  const fetchedAt = now().toISOString();

  // Build the query for the scope.
  let queryWhere = where;
  let envelope: Envelope | undefined;
  let polygon: { rings: Ring[]; distanceMetres?: number } | undefined;
  let bufferTest: ((f: Feature) => boolean) | null = null;
  if (scope.kind === 'envelope') envelope = scope.envelope;
  else if (scope.kind === 'polygon') polygon = { rings: scope.rings };
  else if (scope.kind === 'buffer') {
    const bbox = expandEnvelope(ringsBbox(scope.rings), scope.buffer_m);
    const lonLat = lonLatFieldNames(layer);
    if (lonLat) {
      const bboxWhere = `${lonLat.lon} >= ${bbox[0]} AND ${lonLat.lon} <= ${bbox[2]} AND ${lonLat.lat} >= ${bbox[1]} AND ${lonLat.lat} <= ${bbox[3]}`;
      queryWhere = where ? `(${where}) AND ${bboxWhere}` : bboxWhere;
    } else if (layer.geometryType) {
      polygon = { rings: scope.rings, distanceMetres: scope.buffer_m };
    } else {
      throw new Error(`${source.id}: buffer scope needs longitude/latitude fields or geometry; layer has neither`);
    }
    const rings = scope.rings;
    const buffer = scope.buffer_m;
    bufferTest = (f) => {
      const p = featurePoint(f.attributes, f.geometry);
      return p !== null && pointWithinBuffer(p, rings, buffer);
    };
  }

  const result = await client.queryAll(layer, {
    ...(queryWhere ? { where: queryWhere } : {}),
    ...(envelope ? { envelope } : {}),
    ...(polygon ? { polygon } : {}),
    outFields: allowed,
    returnGeometry: true,
  });
  log(`${source.id}: received ${result.features.length} rows in ${result.pages} page(s) via ${result.method}, complete=${result.complete}`);

  let features = result.features;
  let outOfScope = 0;
  if (bufferTest) {
    features = features.filter(bufferTest);
    outOfScope = result.features.length - features.length;
    if (outOfScope) log(`${source.id}: ${outOfScope} rows outside the polygon + ${(scope as BufferScope).buffer_m} m buffer dropped`);
  }

  const prepared = prepareRecords(features, keyField, allowed);
  const written = store.write(
    {
      source_id: source.id,
      item_id: source.item_id,
      service_url: resolved.service_url,
      layer_url: resolved.layer_url,
      fetched_at: fetchedAt,
      layer_last_edit: layer.lastEditIso,
      layer_last_edit_ms: layer.lastEditDate,
      complete: result.complete,
      where,
      envelope: spatial.kind === 'envelope' ? spatial.envelope : spatial.kind === 'none' ? null : spatial.bbox,
      spatial,
      key_field: keyField,
      field_allowlist: allowed,
      fields_dropped: dropped,
      pages: result.pages,
      paging_method: result.method,
      geometry_type: layer.geometryType,
      records: prepared.records,
      rejected_count: prepared.rejected.length,
    },
    { force: options.force ?? false },
  );
  store.clearLastError(source.id);
  return { ...written, skipped: null, layer, requests: client.http.requestCount - requestsBefore, out_of_scope: outOfScope };
}
