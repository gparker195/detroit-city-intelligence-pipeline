/**
 * Diff engine: compares two snapshots of the same source and emits Change records.
 *
 *   data/changes/<source_id>/<snapshot_id>.ndjson
 *
 * Rows are matched on the snapshot's stable key. Per-field diffs are emitted for modified
 * rows. When the stable key is not the object id (record_id, parcel_id, ticket_id, ...),
 * ObjectId/OBJECTID churn and Shape__* maintenance fields are ignored because the City
 * republishes those on every load without any change in the underlying record.
 *
 * Governance: only fields in the CURRENT snapshot's field_allowlist take part. A field that
 * an older snapshot carried and the allowlist has since excluded (a person-level field, for
 * example) never appears in a Change row, in `field`, `old` or `new`; the added/removed
 * payloads are filtered the same way.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, type SnapshotMeta, type SnapshotRecord, SnapshotStore } from '../snapshot/store.ts';

export type ChangeKind = 'added' | 'removed' | 'modified';

export interface Change {
  change_id: string;
  source_id: string;
  entity_key: string;
  /** Attribute name, 'geometry', or null for whole-row added/removed. */
  field: string | null;
  old: unknown;
  new: unknown;
  /** fetched_at of the newer snapshot. */
  observed_at: string;
  previous_snapshot_id: string;
  snapshot_id: string;
  kind: ChangeKind;
}

export interface DiffSummary {
  source_id: string;
  previous_snapshot_id: string;
  snapshot_id: string;
  observed_at: string;
  added: number;
  removed: number;
  modified_rows: number;
  field_changes: number;
  ignored_fields: string[];
  changes: Change[];
}

const OID_FIELDS = new Set(['objectid', 'fid', 'oid']);

export function isIgnoredField(name: string, keyField: string): boolean {
  if (name === keyField) return false;
  const lower = name.toLowerCase();
  if (lower.startsWith('shape__') || lower.startsWith('shape_')) return true;
  // Object id churn is only noise when the key is something the City maintains (record_id etc).
  return !OID_FIELDS.has(keyField.toLowerCase()) && OID_FIELDS.has(lower);
}

function changeId(parts: readonly unknown[]): string {
  return createHash('sha256').update(parts.map((p) => canonicalJson(p)).join('')).digest('hex').slice(0, 32);
}

export function diffRecords(
  previous: { meta: SnapshotMeta; records: readonly SnapshotRecord[] },
  current: { meta: SnapshotMeta; records: readonly SnapshotRecord[] },
): DiffSummary {
  if (previous.meta.source_id !== current.meta.source_id) {
    throw new Error(`cannot diff ${previous.meta.source_id} against ${current.meta.source_id}`);
  }
  const sourceId = current.meta.source_id;
  const keyField = current.meta.key_field;
  const observedAt = current.meta.fetched_at;
  const ids = { previous_snapshot_id: previous.meta.snapshot_id, snapshot_id: current.meta.snapshot_id };
  const ignored = new Set<string>();
  const allowed = current.meta.field_allowlist?.length ? new Set(current.meta.field_allowlist) : null;
  const permitted = (name: string) => !allowed || allowed.has(name);
  const project = (record: SnapshotRecord) => ({
    attributes: allowed ? Object.fromEntries(Object.entries(record.attributes).filter(([k]) => allowed.has(k))) : record.attributes,
    geometry: record.geometry,
  });
  const changes: Change[] = [];
  const emit = (entityKey: string, field: string | null, oldValue: unknown, newValue: unknown, kind: ChangeKind) => {
    changes.push({
      change_id: changeId([sourceId, entityKey, field, kind, ids.previous_snapshot_id, ids.snapshot_id, oldValue, newValue]),
      source_id: sourceId,
      entity_key: entityKey,
      field,
      old: oldValue,
      new: newValue,
      observed_at: observedAt,
      ...ids,
      kind,
    });
  };

  const before = new Map(previous.records.map((r) => [r.key, r]));
  const after = new Map(current.records.map((r) => [r.key, r]));
  let added = 0;
  let removed = 0;
  let modifiedRows = 0;

  for (const [key, record] of after) {
    const old = before.get(key);
    if (!old) {
      added++;
      emit(key, null, null, project(record), 'added');
      continue;
    }
    let rowChanged = false;
    const fieldNames = new Set([...Object.keys(old.attributes), ...Object.keys(record.attributes)]);
    for (const field of [...fieldNames].sort()) {
      if (isIgnoredField(field, keyField) || !permitted(field)) {
        ignored.add(field);
        continue;
      }
      const a = old.attributes[field];
      const b = record.attributes[field];
      if (canonicalJson(a ?? null) !== canonicalJson(b ?? null)) {
        rowChanged = true;
        emit(key, field, a ?? null, b ?? null, 'modified');
      }
    }
    if (canonicalJson(old.geometry ?? null) !== canonicalJson(record.geometry ?? null)) {
      rowChanged = true;
      emit(key, 'geometry', old.geometry ?? null, record.geometry ?? null, 'modified');
    }
    if (rowChanged) modifiedRows++;
  }
  for (const [key, record] of before) {
    if (!after.has(key)) {
      removed++;
      emit(key, null, project(record), null, 'removed');
    }
  }

  return {
    source_id: sourceId,
    ...ids,
    observed_at: observedAt,
    added,
    removed,
    modified_rows: modifiedRows,
    field_changes: changes.filter((c) => c.kind === 'modified').length,
    ignored_fields: [...ignored].sort(),
    changes,
  };
}

export class ChangeStore {
  readonly dataDir: string;
  readonly changesDir: string;
  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.changesDir = join(dataDir, 'changes');
  }

  path(sourceId: string, snapshotId: string): string {
    return join(this.changesDir, sourceId, `${snapshotId}.ndjson`);
  }

  write(summary: DiffSummary): string {
    const file = this.path(summary.source_id, summary.snapshot_id);
    mkdirSync(join(this.changesDir, summary.source_id), { recursive: true });
    writeFileSync(file, summary.changes.map((c) => canonicalJson(c)).join('\n') + (summary.changes.length ? '\n' : ''));
    return file;
  }

  read(sourceId: string, snapshotId: string): Change[] {
    const file = this.path(sourceId, snapshotId);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Change);
  }
}

export type DiffOutcome =
  | { status: 'no-snapshot'; source_id: string }
  | { status: 'no-previous'; source_id: string; snapshot_id: string }
  | { status: 'diffed'; summary: DiffSummary; file: string };

/** Diffs the latest snapshot against the one before it and writes the change file. */
export function diffLatest(store: SnapshotStore, changes: ChangeStore, sourceId: string): DiffOutcome {
  const snapshots = store.listSnapshots(sourceId);
  const latest = snapshots.at(-1);
  if (!latest) return { status: 'no-snapshot', source_id: sourceId };
  const previous = snapshots.at(-2);
  if (!previous) return { status: 'no-previous', source_id: sourceId, snapshot_id: latest };
  const summary = diffRecords(
    { meta: store.readMeta(sourceId, previous), records: store.readRecords(sourceId, previous) },
    { meta: store.readMeta(sourceId, latest), records: store.readRecords(sourceId, latest) },
  );
  return { status: 'diffed', summary, file: changes.write(summary) };
}
