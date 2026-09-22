/**
 * Immutable raw archive + normalized NDJSON + manifest.
 *
 * data/raw/<source_id>/<fetched_at>__<name>          the bytes exactly as received
 * data/raw/<source_id>/<fetched_at>__<name>.meta.json {url, sha256, bytes, fetched_at, source_updated, content_type}
 * data/normalized/<source_id>.ndjson                  one record per line, replaced on each run
 * data/manifest.json                                  per-source dates and counts
 *
 * Raw files are never overwritten: a name collision with the same sha256 is a no-op, a different
 * sha256 gets a new timestamped file. `fetched_at` is always present; `source_updated` is whatever
 * the source published (HTTP Last-Modified, an API "updated" field, a layer edit date) or null.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const DEFAULT_DATA_DIR = resolve(new URL('../../data', import.meta.url).pathname);

export function dataDir(): string {
  return process.env['DCI_CIVIC_DATA_DIR'] ?? DEFAULT_DATA_DIR;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface RawMeta {
  url: string;
  sha256: string;
  bytes: number;
  fetched_at: string;
  source_updated: string | null;
  content_type: string | null;
  note?: string;
}

export interface ArchiveOptions { root?: string; now?: () => Date }

function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

export function writeRaw(sourceId: string, name: string, bytes: Uint8Array | string, meta: Omit<RawMeta, 'sha256' | 'bytes' | 'fetched_at'> & { fetched_at?: string }, opts: ArchiveOptions = {}): { path: string; meta: RawMeta; created: boolean } {
  const root = opts.root ?? dataDir();
  const dir = join(root, 'raw', sourceId);
  mkdirSync(dir, { recursive: true });
  const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  const hash = sha256(data);
  const fetchedAt = meta.fetched_at ?? (opts.now ?? (() => new Date()))().toISOString();
  // Idempotent: same name + same sha256 already archived -> return the existing file.
  for (const f of readdirSync(dir)) {
    if (f.endsWith(`__${name}.meta.json`)) {
      const existing = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RawMeta;
      if (existing.sha256 === hash) return { path: join(dir, f.replace(/\.meta\.json$/, '')), meta: existing, created: false };
    }
  }
  const base = `${stamp(new Date(fetchedAt))}__${name}`;
  const path = join(dir, base);
  const full: RawMeta = { url: meta.url, sha256: hash, bytes: data.byteLength, fetched_at: fetchedAt, source_updated: meta.source_updated ?? null, content_type: meta.content_type ?? null, ...(meta.note ? { note: meta.note } : {}) };
  writeFileSync(path, data);
  writeFileSync(`${path}.meta.json`, JSON.stringify(full, null, 2) + '\n');
  return { path, meta: full, created: true };
}

export function writeNdjson(sourceId: string, records: unknown[], opts: ArchiveOptions = {}): string {
  const root = opts.root ?? dataDir();
  const dir = join(root, 'normalized');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sourceId}.ndjson`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  return path;
}

export interface ManifestSource {
  source_id: string;
  fetched_at: string;
  source_updated: string | null;
  records: number;
  normalized_path: string;
  raw: { path: string; sha256: string; url: string; source_updated: string | null; fetched_at: string }[];
  status: 'ok' | 'blocked' | 'partial';
  note?: string;
}
export interface Manifest { generated_at: string; sources: Record<string, ManifestSource> }

export function updateManifest(entry: ManifestSource, opts: ArchiveOptions = {}): Manifest {
  const root = opts.root ?? dataDir();
  mkdirSync(root, { recursive: true });
  const path = join(root, 'manifest.json');
  const manifest: Manifest = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Manifest) : { generated_at: '', sources: {} };
  manifest.sources[entry.source_id] = entry;
  manifest.generated_at = (opts.now ?? (() => new Date()))().toISOString();
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export function rawRef(r: { path: string; meta: RawMeta }): ManifestSource['raw'][number] {
  return { path: r.path, sha256: r.meta.sha256, url: r.meta.url, source_updated: r.meta.source_updated, fetched_at: r.meta.fetched_at };
}
