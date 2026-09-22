/**
 * data/manifest.json: the latest snapshot per registered source with both dates the product
 * must always show together: `layer_last_edit` (City updated) and `fetched_at` (we fetched).
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceDefinition } from '../registry/sources.ts';
import { SnapshotStore, type SpatialScope } from '../snapshot/store.ts';
import { computeHealth, type HealthStatus } from '../health/status.ts';

export interface ManifestEntry {
  source_id: string;
  title: string;
  item_id: string;
  attribution: string;
  /** Verbatim provider disclaimer for this source (zoning map disclaimer), or null. */
  disclaimer_text: string | null;
  /** Verbatim City open-data AS-IS reference. */
  open_data_disclaimer: string;
  cadence: string;
  lifecycle: string;
  scope: string;
  terms_verified_on: string;
  notes: string | null;
  snapshot_id: string | null;
  layer_last_edit: string | null;
  fetched_at: string | null;
  row_count: number | null;
  rejected_count: number | null;
  complete: boolean | null;
  sha256: string | null;
  where: string | null;
  envelope: number[] | null;
  spatial: SpatialScope | null;
  health: HealthStatus;
  health_freshness: string;
  health_completeness: string;
  health_reasons: string[];
  last_error: { at: string; message: string } | null;
  records_path: string | null;
}

export interface Manifest {
  generated_at: string;
  disclaimer: string;
  sources: ManifestEntry[];
}

export function buildManifest(store: SnapshotStore, sources: readonly SourceDefinition[], now = new Date()): Manifest {
  const disclaimer = sources[0]?.open_data_disclaimer ?? '';
  return {
    generated_at: now.toISOString(),
    disclaimer,
    sources: sources.map((source) => {
      const pointer = store.readLatest(source.id);
      const meta = pointer ? store.readMeta(source.id, pointer.snapshot_id) : null;
      const health = computeHealth({ source, latest: meta, lastError: store.readLastError(source.id), now });
      return {
        source_id: source.id,
        title: source.title,
        item_id: source.item_id,
        attribution: source.attribution,
        disclaimer_text: source.disclaimer_text,
        open_data_disclaimer: source.open_data_disclaimer,
        cadence: source.cadence,
        lifecycle: source.lifecycle,
        scope: source.scope,
        terms_verified_on: source.terms_verified_on,
        notes: source.notes ?? null,
        snapshot_id: meta?.snapshot_id ?? null,
        layer_last_edit: meta?.layer_last_edit ?? null,
        fetched_at: meta?.fetched_at ?? null,
        row_count: meta?.row_count ?? null,
        rejected_count: meta?.rejected_count ?? null,
        complete: meta?.complete ?? null,
        sha256: meta?.sha256 ?? null,
        where: meta?.where ?? null,
        envelope: meta?.envelope ?? null,
        spatial: meta?.spatial ?? null,
        health: health.status,
        health_freshness: health.freshness,
        health_completeness: health.completeness,
        health_reasons: health.reasons,
        last_error: health.last_error,
        records_path: meta ? `raw/${source.id}/${meta.snapshot_id}/records.ndjson` : null,
      };
    }),
  };
}

export function writeManifest(store: SnapshotStore, sources: readonly SourceDefinition[], now = new Date()): { file: string; manifest: Manifest } {
  const manifest = buildManifest(store, sources, now);
  const file = join(store.dataDir, 'manifest.json');
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  return { file, manifest };
}
