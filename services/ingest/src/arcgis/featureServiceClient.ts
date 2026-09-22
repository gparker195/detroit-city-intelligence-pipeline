/**
 * Generic client for ArcGIS FeatureServer layers.
 *
 * Paging strategy (written fresh in TypeScript; the shape follows openaddresses/pyesridump):
 *   1. Read layer metadata: fields, geometryType, maxRecordCount, editingInfo.lastEditDate,
 *      advancedQueryCapabilities.supportsPagination, objectIdField.
 *   2. If the layer supports pagination, page /query with resultOffset + resultRecordCount,
 *      ordered by the object id field so pages are stable, until a page comes back short
 *      and exceededTransferLimit is not set.
 *   3. Otherwise fall back to object-id chunking: returnIdsOnly=true, then query
 *      `OID IN (...)` in chunks of maxRecordCount.
 *
 * Rate limiting, retries and the identifying User-Agent live in util/http.ts.
 */

import { HttpClient, buildUrl, type HttpOptions } from '../util/http.ts';

export interface LayerField {
  name: string;
  type: string;
  alias?: string;
}

export interface LayerInfo {
  url: string;
  id: number;
  name: string;
  geometryType: string | null;
  objectIdField: string;
  fields: LayerField[];
  maxRecordCount: number;
  supportsPagination: boolean;
  /** Epoch milliseconds from editingInfo.lastEditDate, or null when the layer does not publish it. */
  lastEditDate: number | null;
  /** ISO 8601 rendering of lastEditDate, or null. */
  lastEditIso: string | null;
}

/** WGS84 bounding box: [minLon, minLat, maxLon, maxLat]. */
export type Envelope = [number, number, number, number];

/** A polygon spatial filter (WGS84 rings), optionally buffered server-side by `distanceMetres`. */
export interface PolygonFilter {
  rings: [number, number][][];
  distanceMetres?: number;
}

export interface QueryOptions {
  where?: string;
  envelope?: Envelope;
  /** Polygon intersect filter; sent by POST because rings do not fit in a URL. Wins over envelope. */
  polygon?: PolygonFilter;
  outFields?: string[];
  returnGeometry?: boolean;
  /** Page size; clamped to the layer's maxRecordCount. */
  pageSize?: number;
  /** Safety cap on total rows; undefined = unlimited. */
  maxRows?: number;
}

export interface Feature {
  attributes: Record<string, unknown>;
  geometry?: unknown;
}

export interface QueryPage {
  features: Feature[];
  exceededTransferLimit?: boolean;
  objectIdFieldName?: string;
  fields?: LayerField[];
  error?: { code: number; message: string };
}

export interface QueryResult {
  features: Feature[];
  pages: number;
  /** True when every page was fetched and no transfer limit was left dangling. */
  complete: boolean;
  method: 'offset' | 'oid-chunks';
}

interface RawLayerInfo {
  id?: number;
  name?: string;
  geometryType?: string;
  objectIdField?: string;
  uniqueIdField?: { name?: string };
  fields?: LayerField[];
  maxRecordCount?: number;
  advancedQueryCapabilities?: { supportsPagination?: boolean };
  editingInfo?: { lastEditDate?: number; dataLastEditDate?: number };
}

export function parseEnvelope(text: string): Envelope {
  const parts = text.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`envelope must be minLon,minLat,maxLon,maxLat; got "${text}"`);
  }
  const [minLon, minLat, maxLon, maxLat] = parts as Envelope;
  if (minLon >= maxLon || minLat >= maxLat) throw new Error(`envelope is inverted: "${text}"`);
  return [minLon, minLat, maxLon, maxLat];
}

export class FeatureServiceClient {
  readonly http: HttpClient;

  constructor(options: HttpOptions | HttpClient = {}) {
    this.http = options instanceof HttpClient ? options : new HttpClient(options);
  }

  /** Reads /FeatureServer/<layer>?f=json. `layerUrl` must include the layer id. */
  async getLayerInfo(layerUrl: string): Promise<LayerInfo> {
    const raw = await this.http.getJson<RawLayerInfo>(buildUrl(layerUrl, { f: 'json' }));
    const fields = raw.fields ?? [];
    const oidFromFields = fields.find((f) => f.type === 'esriFieldTypeOID')?.name;
    const objectIdField = raw.objectIdField ?? raw.uniqueIdField?.name ?? oidFromFields ?? 'OBJECTID';
    const lastEdit = raw.editingInfo?.lastEditDate ?? raw.editingInfo?.dataLastEditDate ?? null;
    return {
      url: layerUrl,
      id: raw.id ?? 0,
      name: raw.name ?? '',
      geometryType: raw.geometryType ?? null,
      objectIdField,
      fields: fields.map(({ name, type, alias }) => (alias === undefined ? { name, type } : { name, type, alias })),
      maxRecordCount: raw.maxRecordCount ?? 1000,
      supportsPagination: raw.advancedQueryCapabilities?.supportsPagination ?? false,
      lastEditDate: lastEdit,
      lastEditIso: lastEdit === null ? null : new Date(lastEdit).toISOString(),
    };
  }

  private baseQueryParams(options: QueryOptions): Record<string, string | number | boolean | undefined> {
    const params: Record<string, string | number | boolean | undefined> = {
      f: 'json',
      where: options.where && options.where.trim() ? options.where : '1=1',
      outFields: options.outFields && options.outFields.length ? options.outFields.join(',') : '*',
      returnGeometry: options.returnGeometry ?? true,
      outSR: 4326,
    };
    if (options.polygon) {
      params.geometry = JSON.stringify({ rings: options.polygon.rings, spatialReference: { wkid: 4326 } });
      params.geometryType = 'esriGeometryPolygon';
      params.inSR = 4326;
      params.spatialRel = 'esriSpatialRelIntersects';
      if (options.polygon.distanceMetres && options.polygon.distanceMetres > 0) {
        params.distance = options.polygon.distanceMetres;
        params.units = 'esriSRUnit_Meter';
      }
    } else if (options.envelope) {
      params.geometry = options.envelope.join(',');
      params.geometryType = 'esriGeometryEnvelope';
      params.inSR = 4326;
      params.spatialRel = 'esriSpatialRelIntersects';
    }
    return params;
  }

  /** GET for small parameter sets, POST when a polygon filter is present. */
  private request<T>(url: string, params: Record<string, string | number | boolean | undefined>, usePost: boolean): Promise<T> {
    return usePost ? this.http.postJson<T>(url, params) : this.http.getJson<T>(buildUrl(url, params));
  }

  /** Fetches every matching feature, paging as the layer allows. */
  async queryAll(layer: LayerInfo, options: QueryOptions = {}): Promise<QueryResult> {
    const pageSize = Math.max(1, Math.min(options.pageSize ?? layer.maxRecordCount, layer.maxRecordCount));
    return layer.supportsPagination
      ? this.queryByOffset(layer, options, pageSize)
      : this.queryByOidChunks(layer, options, pageSize);
  }

  private async queryByOffset(layer: LayerInfo, options: QueryOptions, pageSize: number): Promise<QueryResult> {
    const queryUrl = `${layer.url}/query`;
    const features: Feature[] = [];
    let offset = 0;
    let pages = 0;
    let complete = false;
    const usePost = options.polygon !== undefined;
    for (;;) {
      const page = await this.request<QueryPage>(
        queryUrl,
        {
          ...this.baseQueryParams(options),
          orderByFields: layer.objectIdField,
          resultOffset: offset,
          resultRecordCount: pageSize,
        },
        usePost,
      );
      pages++;
      const got = page.features ?? [];
      features.push(...got);
      offset += got.length;
      if (options.maxRows !== undefined && features.length >= options.maxRows) {
        features.length = options.maxRows;
        complete = !(page.exceededTransferLimit || got.length === pageSize);
        break;
      }
      if (got.length === 0 || (got.length < pageSize && !page.exceededTransferLimit)) {
        complete = true;
        break;
      }
      // A full page with no explicit flag still might be the last one; keep going until a short page.
    }
    return { features, pages, complete, method: 'offset' };
  }

  private async queryByOidChunks(layer: LayerInfo, options: QueryOptions, pageSize: number): Promise<QueryResult> {
    const queryUrl = `${layer.url}/query`;
    const base = this.baseQueryParams(options);
    const usePost = options.polygon !== undefined;
    const ids = await this.request<{ objectIds?: number[]; objectIdFieldName?: string }>(
      queryUrl,
      { f: 'json', where: base.where, geometry: base.geometry, geometryType: base.geometryType, inSR: base.inSR, spatialRel: base.spatialRel, distance: base.distance, units: base.units, returnIdsOnly: true },
      usePost,
    );
    const oidField = ids.objectIdFieldName ?? layer.objectIdField;
    const all = [...(ids.objectIds ?? [])].sort((a, b) => a - b);
    const features: Feature[] = [];
    let pages = 1;
    for (let i = 0; i < all.length; i += pageSize) {
      const chunk = all.slice(i, i + pageSize);
      const page = await this.http.getJson<QueryPage>(
        buildUrl(queryUrl, {
          ...base,
          where: `${oidField} IN (${chunk.join(',')})`,
          geometry: undefined,
          geometryType: undefined,
          inSR: undefined,
          spatialRel: undefined,
          distance: undefined,
          units: undefined,
        }),
      );
      pages++;
      features.push(...(page.features ?? []));
      if (options.maxRows !== undefined && features.length >= options.maxRows) {
        features.length = options.maxRows;
        return { features, pages, complete: features.length === all.length, method: 'oid-chunks' };
      }
    }
    return { features, pages, complete: features.length === all.length, method: 'oid-chunks' };
  }
}
