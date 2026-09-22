/**
 * `pnpm run fetch:study-area [study_area_id]`: every registered source for one study area.
 *
 *   1. citywide sources first (the SNF layer among them) so the polygon can be resolved
 *   2. resolve the study-area polygon from the SNF snapshot
 *   3. polygon sources intersecting the polygon; buffer sources within polygon + buffer_m
 *   4. diff every source that has two snapshots, then health and manifest
 *
 * One failing source does not stop the run: the error is recorded in last_error.json and the
 * run reports it. All requests go through the same rate-limited client (2 req/s).
 */

import { FeatureServiceClient } from './arcgis/featureServiceClient.ts';
import { ChangeStore, diffLatest } from './diff/engine.ts';
import { fetchSource, type FetchScopeOption } from './fetch.ts';
import { writeHealth } from './health/status.ts';
import { writeManifest } from './manifest/manifest.ts';
import { SOURCES, type SourceDefinition } from './registry/sources.ts';
import { getStudyArea, resolveStudyArea, type ResolvedStudyArea } from './registry/studyAreas.ts';
import { SnapshotStore } from './snapshot/store.ts';

export interface SourceRunReport {
  source_id: string;
  scope: SourceDefinition['scope'];
  status: 'created' | 'identical' | 'unchanged' | 'failed';
  row_count: number | null;
  received_count: number | null;
  out_of_scope: number;
  layer_last_edit: string | null;
  fetched_at: string | null;
  snapshot_id: string | null;
  requests: number;
  diff: { added: number; removed: number; modified_rows: number } | 'no-previous' | 'no-snapshot' | null;
  error: string | null;
  seconds: number;
}

export interface StudyAreaRunReport {
  study_area: { id: string; name: string; bbox: number[]; buffer_m: number; source_snapshot_id: string };
  started_at: string;
  finished_at: string;
  sources: SourceRunReport[];
  health_file: string;
  manifest_file: string;
}

export interface StudyAreaRunOptions {
  studyAreaId: string;
  dataDir: string;
  client?: FeatureServiceClient;
  sources?: readonly SourceDefinition[];
  only?: readonly string[];
  force?: boolean;
  now?: () => Date;
  log?: (message: string) => void;
}

export async function runStudyArea(options: StudyAreaRunOptions): Promise<StudyAreaRunReport> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const store = new SnapshotStore(options.dataDir);
  const changes = new ChangeStore(options.dataDir);
  const client = options.client ?? new FeatureServiceClient({ log });
  const def = getStudyArea(options.studyAreaId);
  const all = (options.sources ?? SOURCES).filter((s) => !options.only || options.only.includes(s.id));
  const startedAt = now().toISOString();
  const reports: SourceRunReport[] = [];

  const runOne = async (source: SourceDefinition, scope: FetchScopeOption): Promise<void> => {
    const t0 = Date.now();
    try {
      const result = await fetchSource(client, store, source, { scope, force: options.force ?? false, now, log });
      const m = result.meta;
      reports.push({
        source_id: source.id,
        scope: source.scope,
        status: result.skipped === 'unchanged' ? 'unchanged' : result.created ? 'created' : 'identical',
        row_count: m.row_count,
        received_count: m.received_count,
        out_of_scope: result.out_of_scope,
        layer_last_edit: m.layer_last_edit,
        fetched_at: m.fetched_at,
        snapshot_id: m.snapshot_id,
        requests: result.requests,
        diff: null,
        error: null,
        seconds: Math.round((Date.now() - t0) / 100) / 10,
      });
    } catch (error) {
      const message = (error as Error).message;
      store.writeLastError(source.id, { at: now().toISOString(), message });
      log(`${source.id}: FAILED ${message}`);
      reports.push({
        source_id: source.id,
        scope: source.scope,
        status: 'failed',
        row_count: null,
        received_count: null,
        out_of_scope: 0,
        layer_last_edit: null,
        fetched_at: null,
        snapshot_id: null,
        requests: 0,
        diff: null,
        error: message,
        seconds: Math.round((Date.now() - t0) / 100) / 10,
      });
    }
  };

  // 1. citywide sources, SNF first.
  const citywide = all.filter((s) => s.scope === 'citywide').sort((a, b) => (a.id === def.source_id ? -1 : b.id === def.source_id ? 1 : 0));
  for (const source of citywide) await runOne(source, { kind: 'none' });

  // 2. the polygon.
  let area: ResolvedStudyArea;
  try {
    area = resolveStudyArea(store, def);
  } catch (error) {
    throw new Error(`cannot resolve study area ${def.id}: ${(error as Error).message}`);
  }
  log(`study area ${area.name}: ${area.rings[0]?.length ?? 0} vertices, bbox ${area.bbox.map((n) => n.toFixed(4)).join(',')}, buffer ${area.buffer_m} m`);

  // 3. scoped sources.
  for (const source of all.filter((s) => s.scope === 'polygon')) {
    await runOne(source, { kind: 'polygon', study_area_id: area.id, rings: area.rings });
  }
  for (const source of all.filter((s) => s.scope === 'buffer')) {
    await runOne(source, { kind: 'buffer', study_area_id: area.id, rings: area.rings, buffer_m: area.buffer_m });
  }

  // 4. diff, health, manifest.
  for (const report of reports) {
    if (report.status === 'failed') continue;
    const outcome = diffLatest(store, changes, report.source_id);
    report.diff = outcome.status === 'diffed' ? { added: outcome.summary.added, removed: outcome.summary.removed, modified_rows: outcome.summary.modified_rows } : outcome.status;
  }
  const health = writeHealth(store, options.sources ?? SOURCES, now());
  const manifest = writeManifest(store, options.sources ?? SOURCES, now());

  return {
    study_area: { id: area.id, name: area.name, bbox: area.bbox, buffer_m: area.buffer_m, source_snapshot_id: area.source_snapshot_id },
    started_at: startedAt,
    finished_at: now().toISOString(),
    sources: reports,
    health_file: health.file,
    manifest_file: manifest.file,
  };
}
