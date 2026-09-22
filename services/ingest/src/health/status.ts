/**
 * Per-source health, written to data/health.json.
 *
 * Freshness and completeness are independent axes and both are always reported:
 *   freshness:    fresh | stale | never          (age of last success vs cadence)
 *   completeness: complete | partial | empty | none
 *
 * The single `status` badge is derived for display, in this precedence:
 *   unavailable  no successful snapshot and the last attempt failed
 *   loading      no snapshot yet and no failure recorded
 *   partial      latest snapshot is incomplete, or received rows but kept none, or rejected some
 *   stale        last success older than cadence + grace
 *   degraded     a good snapshot exists but the most recent attempt failed
 *   nominal      everything else
 *
 * A snapshot with zero valid rows out of nonzero received is 'partial', never 'nominal'.
 * A genuinely empty feed (zero received, complete) is 'nominal' with completeness 'empty'.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CADENCE_HOURS, type Cadence, type SourceDefinition } from '../registry/sources.ts';
import { SnapshotStore, type LastError, type SnapshotMeta } from '../snapshot/store.ts';

export type HealthStatus = 'nominal' | 'loading' | 'degraded' | 'stale' | 'partial' | 'unavailable';
export type Freshness = 'fresh' | 'stale' | 'never';
export type Completeness = 'complete' | 'partial' | 'empty' | 'none';

export interface SourceHealth {
  source_id: string;
  status: HealthStatus;
  freshness: Freshness;
  completeness: Completeness;
  cadence: Cadence;
  cadence_hours: number;
  stale_after_hours: number;
  last_success_at: string | null;
  age_hours: number | null;
  layer_last_edit: string | null;
  snapshot_id: string | null;
  row_count: number | null;
  received_count: number | null;
  rejected_count: number | null;
  complete: boolean | null;
  last_error: LastError | null;
  reasons: string[];
}

export interface HealthFile {
  generated_at: string;
  sources: SourceHealth[];
}

export interface HealthInput {
  source: Pick<SourceDefinition, 'id' | 'cadence'>;
  latest: Pick<SnapshotMeta, 'snapshot_id' | 'fetched_at' | 'layer_last_edit' | 'row_count' | 'received_count' | 'rejected_count' | 'complete'> | null;
  lastError: LastError | null;
  now: Date;
  /** Multiplier on cadence before a source is stale. Default 1.5 (36 h for daily). */
  graceFactor?: number;
}

export function computeHealth(input: HealthInput): SourceHealth {
  const { source, latest, lastError, now } = input;
  const cadenceHours = CADENCE_HOURS[source.cadence];
  const staleAfter = cadenceHours * (input.graceFactor ?? 1.5);
  const reasons: string[] = [];

  let freshness: Freshness = 'never';
  let ageHours: number | null = null;
  if (latest) {
    ageHours = (now.getTime() - new Date(latest.fetched_at).getTime()) / 3_600_000;
    freshness = ageHours > staleAfter ? 'stale' : 'fresh';
    if (freshness === 'stale') reasons.push(`last success ${ageHours.toFixed(1)} h ago exceeds ${staleAfter} h`);
  }

  let completeness: Completeness = 'none';
  if (latest) {
    if (!latest.complete) {
      completeness = 'partial';
      reasons.push('paging did not complete');
    } else if (latest.received_count > 0 && latest.row_count === 0) {
      completeness = 'partial';
      reasons.push(`received ${latest.received_count} rows but kept 0`);
    } else if (latest.rejected_count > 0) {
      completeness = 'partial';
      reasons.push(`${latest.rejected_count} of ${latest.received_count} rows rejected`);
    } else if (latest.row_count === 0) {
      completeness = 'empty';
    } else {
      completeness = 'complete';
    }
  }

  const failedSinceSuccess = !!lastError && (!latest || new Date(lastError.at).getTime() > new Date(latest.fetched_at).getTime());
  if (failedSinceSuccess) reasons.push(`last attempt failed: ${lastError!.message}`);

  let status: HealthStatus;
  if (!latest) status = lastError ? 'unavailable' : 'loading';
  else if (completeness === 'partial') status = 'partial';
  else if (freshness === 'stale') status = 'stale';
  else if (failedSinceSuccess) status = 'degraded';
  else status = 'nominal';

  return {
    source_id: source.id,
    status,
    freshness,
    completeness,
    cadence: source.cadence,
    cadence_hours: cadenceHours,
    stale_after_hours: staleAfter,
    last_success_at: latest?.fetched_at ?? null,
    age_hours: ageHours === null ? null : Math.round(ageHours * 100) / 100,
    layer_last_edit: latest?.layer_last_edit ?? null,
    snapshot_id: latest?.snapshot_id ?? null,
    row_count: latest?.row_count ?? null,
    received_count: latest?.received_count ?? null,
    rejected_count: latest?.rejected_count ?? null,
    complete: latest?.complete ?? null,
    last_error: lastError,
    reasons,
  };
}

export function computeAllHealth(store: SnapshotStore, sources: readonly SourceDefinition[], now = new Date()): HealthFile {
  return {
    generated_at: now.toISOString(),
    sources: sources.map((source) => {
      const pointer = store.readLatest(source.id);
      const latest = pointer ? store.readMeta(source.id, pointer.snapshot_id) : null;
      return computeHealth({ source, latest, lastError: store.readLastError(source.id), now });
    }),
  };
}

export function writeHealth(store: SnapshotStore, sources: readonly SourceDefinition[], now = new Date()): { file: string; health: HealthFile } {
  const health = computeAllHealth(store, sources, now);
  const file = join(store.dataDir, 'health.json');
  writeFileSync(file, JSON.stringify(health, null, 2) + '\n');
  return { file, health };
}
