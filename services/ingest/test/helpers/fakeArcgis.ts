/**
 * A FetchLike that serves the recorded fixtures without touching the network.
 * Routes: ArcGIS item JSON, layer metadata, and /query with resultOffset/resultRecordCount,
 * outFields and returnCountOnly honoured. A `script` can force status codes per request index.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from '../../src/util/http.ts';
import type { Feature } from '../../src/arcgis/featureServiceClient.ts';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as T;
}

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
}

export interface FakeArcgisOptions {
  item: unknown;
  layer: { fields: { name: string; type: string }[]; maxRecordCount?: number } & Record<string, unknown>;
  features: Feature[];
  /** Per-request-index overrides: status code, optional body. */
  script?: Record<number, { status: number; body?: string }>;
  /** Override page size the fake service enforces (defaults to layer.maxRecordCount). */
  serverPageLimit?: number;
}

export function makeFakeArcgis(options: FakeArcgisOptions): { fetchImpl: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const limit = options.serverPageLimit ?? options.layer.maxRecordCount ?? 1000;
  const respond = (status: number, body: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });

  const fetchImpl: FetchLike = async (url, init) => {
    const index = requests.length;
    requests.push({ url, headers: init?.headers ?? {} });
    const scripted = options.script?.[index];
    if (scripted) return respond(scripted.status, scripted.body ?? { error: { code: scripted.status, message: 'scripted' } });

    const u = new URL(url);
    if (u.pathname.includes('/sharing/rest/content/items/')) return respond(200, options.item);
    if (u.pathname.endsWith('/query')) {
      const p = u.searchParams;
      let features = options.features;
      if (p.get('returnCountOnly') === 'true') return respond(200, { count: features.length });
      if (p.get('returnIdsOnly') === 'true') {
        return respond(200, { objectIdFieldName: 'ObjectId', objectIds: features.map((f) => f.attributes.ObjectId as number) });
      }
      const where = p.get('where') ?? '1=1';
      const inMatch = /IN \(([^)]*)\)/.exec(where);
      if (inMatch) {
        const ids = new Set(inMatch[1]!.split(',').map((s) => Number(s.trim())));
        features = features.filter((f) => ids.has(f.attributes.ObjectId as number));
      }
      const offset = Number(p.get('resultOffset') ?? 0);
      const requested = Number(p.get('resultRecordCount') ?? limit);
      const pageSize = Math.min(requested, limit);
      const page = features.slice(offset, offset + pageSize);
      const outFields = p.get('outFields') ?? '*';
      const projected = page.map((f) => ({
        attributes:
          outFields === '*'
            ? f.attributes
            : Object.fromEntries(outFields.split(',').filter((n) => n in f.attributes).map((n) => [n, f.attributes[n]])),
        ...(p.get('returnGeometry') === 'false' ? {} : { geometry: f.geometry }),
      }));
      return respond(200, {
        objectIdFieldName: 'ObjectId',
        geometryType: 'esriGeometryPoint',
        fields: options.layer.fields,
        features: projected,
        exceededTransferLimit: offset + pageSize < features.length,
      });
    }
    // layer metadata
    return respond(200, options.layer);
  };
  return { fetchImpl, requests };
}

/** A fake clock + sleep pair that advances time without waiting. */
export function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms: number) => {
      t += ms;
    },
  };
}
