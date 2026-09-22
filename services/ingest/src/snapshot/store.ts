/**
 * Immutable snapshot store on the local filesystem.
 *
 *   data/raw/<source_id>/<snapshot_id>/records.ndjson   sorted by stable key, canonical JSON per line
 *   data/raw/<source_id>/<snapshot_id>/meta.json        SnapshotMeta
 *   data/raw/<source_id>/latest.json                    pointer {snapshot_id, sha256, fetched_at}
 *   data/raw/<source_id>/last_error.json                written by the CLI when a fetch fails
 *
 * snapshot_id is the fetch time as ISO 8601 with ':' replaced by '-' so the folder name is
 * safe on every filesystem; meta.fetched_at keeps the exact ISO value.
 *
 * Idempotent: identical data yields an identical sha256; when it matches latest.json no new
 * snapshot folder is created unless `force` is set.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Feature } from '../arcgis/featureServiceClient.ts';
import type { Envelope } from '../arcgis/featureServiceClient.ts';

export interface SnapshotRecord {
  key: string;
  attributes: Record<string, unknown>;
  geometry: unknown | null;
}

/** How the snapshot was scoped spatially. `envelope` on the meta stays for older snapshots. */
export type SpatialScope =
  | { kind: 'none' }
  | { kind: 'envelope'; envelope: Envelope }
  | { kind: 'polygon'; study_area_id: string; bbox: Envelope; buffer_m: 0 }
  | { kind: 'buffer'; study_area_id: string; bbox: Envelope; buffer_m: number };

export interface SnapshotMeta {
  snapshot_id: string;
  source_id: string;
  item_id: string;
  service_url: string;
  layer_url: string;
  fetched_at: string;
  /** ISO of editingInfo.lastEditDate as read at fetch time, or null when the layer has none. */
  layer_last_edit: string | null;
  layer_last_edit_ms: number | null;
  row_count: number;
  /** Rows received from the service before rejection (= row_count + rejected_count). */
  received_count: number;
  rejected_count: number;
  complete: boolean;
  sha256: string;
  where: string | null;
  /** Bounding box of the scope (the envelope itself, or the polygon's bbox), or null. */
  envelope: Envelope | null;
  spatial?: SpatialScope;
  key_field: string;
  field_allowlist: string[];
  fields_dropped: string[];
  pages: number;
  paging_method: string;
  geometry_type: string | null;
}

export interface LatestPointer {
  snapshot_id: string;
  sha256: string;
  fetched_at: string;
  layer_last_edit: string | null;
}

export interface LastError {
  at: string;
  message: string;
}

export interface PreparedRecords {
  records: SnapshotRecord[];
  rejected: { index: number; reason: string }[];
}

export function snapshotIdFromDate(date: Date): string {
  return date.toISOString().replace(/:/g, '-');
}

/** Canonical JSON: object keys sorted recursively so byte output is stable. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Picks the first candidate present among the layer's field names. */
export function chooseKeyField(candidates: readonly string[], fieldNames: readonly string[]): string {
  const lower = new Map(fieldNames.map((n) => [n.toLowerCase(), n]));
  for (const candidate of candidates) {
    const hit = lower.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  throw new Error(`none of the stable key candidates [${candidates.join(', ')}] exist in fields [${fieldNames.join(', ')}]`);
}

export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Applies the allowlist, derives the stable key, rejects rows without a usable key, and
 * sorts. Duplicate keys are disambiguated with '#n' in canonical-content order so the
 * output is still reproducible.
 */
export function prepareRecords(features: readonly Feature[], keyField: string, allowedFields: readonly string[]): PreparedRecords {
  const allowed = new Set(allowedFields);
  const rejected: PreparedRecords['rejected'] = [];
  const draft: SnapshotRecord[] = [];
  features.forEach((feature, index) => {
    const attrs = feature?.attributes;
    if (!attrs || typeof attrs !== 'object') {
      rejected.push({ index, reason: 'missing attributes' });
      return;
    }
    const rawKey = attrs[keyField];
    if (rawKey === null || rawKey === undefined || String(rawKey).trim() === '') {
      rejected.push({ index, reason: `missing stable key ${keyField}` });
      return;
    }
    const attributes: Record<string, unknown> = {};
    for (const name of Object.keys(attrs)) {
      if (allowed.has(name)) attributes[name] = attrs[name];
    }
    draft.push({ key: String(rawKey).trim(), attributes, geometry: feature.geometry ?? null });
  });

  draft.sort((a, b) => compareKeys(a.key, b.key) || compareKeys(canonicalJson(a), canonicalJson(b)));
  const seen = new Map<string, number>();
  const records = draft.map((record) => {
    const n = (seen.get(record.key) ?? 0) + 1;
    seen.set(record.key, n);
    return n === 1 ? record : { ...record, key: `${record.key}#${n}` };
  });
  return { records, rejected };
}

export function serializeRecords(records: readonly SnapshotRecord[]): string {
  return records.map((r) => canonicalJson(r)).join('\n') + (records.length ? '\n' : '');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class SnapshotStore {
  readonly dataDir: string;
  readonly rawDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.rawDir = join(dataDir, 'raw');
  }

  sourceDir(sourceId: string): string {
    return join(this.rawDir, sourceId);
  }

  snapshotDir(sourceId: string, snapshotId: string): string {
    return join(this.sourceDir(sourceId), snapshotId);
  }

  readLatest(sourceId: string): LatestPointer | null {
    const path = join(this.sourceDir(sourceId), 'latest.json');
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as LatestPointer) : null;
  }

  readLastError(sourceId: string): LastError | null {
    const path = join(this.sourceDir(sourceId), 'last_error.json');
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as LastError) : null;
  }

  writeLastError(sourceId: string, error: LastError): void {
    mkdirSync(this.sourceDir(sourceId), { recursive: true });
    writeFileSync(join(this.sourceDir(sourceId), 'last_error.json'), JSON.stringify(error, null, 2) + '\n');
  }

  clearLastError(sourceId: string): void {
    const path = join(this.sourceDir(sourceId), 'last_error.json');
    if (existsSync(path)) rmSync(path);
  }

  readMeta(sourceId: string, snapshotId: string): SnapshotMeta {
    return JSON.parse(readFileSync(join(this.snapshotDir(sourceId, snapshotId), 'meta.json'), 'utf8')) as SnapshotMeta;
  }

  readRecords(sourceId: string, snapshotId: string): SnapshotRecord[] {
    const text = readFileSync(join(this.snapshotDir(sourceId, snapshotId), 'records.ndjson'), 'utf8');
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as SnapshotRecord);
  }

  /** Snapshot ids for a source, oldest first (ids sort chronologically). */
  listSnapshots(sourceId: string): string[] {
    const dir = this.sourceDir(sourceId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'meta.json')))
      .map((entry) => entry.name)
      .sort();
  }

  listSources(): string[] {
    if (!existsSync(this.rawDir)) return [];
    return readdirSync(this.rawDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  /**
   * Writes a snapshot unless its sha256 equals the latest pointer (and force is false).
   * Returns whether a new snapshot was created and the meta of the resulting current snapshot.
   */
  write(
    input: Omit<SnapshotMeta, 'snapshot_id' | 'sha256' | 'row_count' | 'received_count' | 'rejected_count'> & {
      records: SnapshotRecord[];
      rejected_count: number;
      fetched_at: string;
    },
    options: { force?: boolean } = {},
  ): { created: boolean; meta: SnapshotMeta; dir: string } {
    const { records, ...rest } = input;
    const body = serializeRecords(records);
    const hash = sha256(body);
    const latest = this.readLatest(rest.source_id);
    if (latest && latest.sha256 === hash && !options.force) {
      return { created: false, meta: this.readMeta(rest.source_id, latest.snapshot_id), dir: this.snapshotDir(rest.source_id, latest.snapshot_id) };
    }
    const snapshotId = snapshotIdFromDate(new Date(rest.fetched_at));
    const meta: SnapshotMeta = {
      ...rest,
      snapshot_id: snapshotId,
      row_count: records.length,
      received_count: records.length + rest.rejected_count,
      rejected_count: rest.rejected_count,
      sha256: hash,
    };
    const dir = this.snapshotDir(rest.source_id, snapshotId);
    if (existsSync(dir)) throw new Error(`snapshot ${dir} already exists; snapshots are immutable`);
    const tmp = `${dir}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'records.ndjson'), body);
    writeFileSync(join(tmp, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
    renameSync(tmp, dir);
    const pointer: LatestPointer = { snapshot_id: snapshotId, sha256: hash, fetched_at: meta.fetched_at, layer_last_edit: meta.layer_last_edit };
    writeFileSync(join(this.sourceDir(rest.source_id), 'latest.json'), JSON.stringify(pointer, null, 2) + '\n');
    return { created: true, meta, dir };
  }
}
