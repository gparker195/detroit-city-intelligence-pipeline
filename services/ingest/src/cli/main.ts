/**
 * CLI entry. Invoke through pnpm (note: `pnpm fetch` alone is pnpm's own store command, so
 * always use `pnpm run`):
 *
 *   pnpm run fetch <source_id> [--envelope minLon,minLat,maxLon,maxLat] [--where "..."] [--force] [--no-envelope] [--no-skip]
 *   pnpm run fetch:study-area [study_area_id] [--only a,b,c] [--force]
 *   pnpm run diff <source_id>
 *   pnpm run health
 *   pnpm run manifest
 *
 * Default envelope is the Livernois & McNichols study area (about 1.4 km box).
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { FeatureServiceClient, parseEnvelope, type Envelope } from '../arcgis/featureServiceClient.ts';
import { getSource, SOURCES } from '../registry/sources.ts';
import { SnapshotStore } from '../snapshot/store.ts';
import { ChangeStore, diffLatest } from '../diff/engine.ts';
import { writeHealth } from '../health/status.ts';
import { writeManifest } from '../manifest/manifest.ts';
import { fetchSource } from '../fetch.ts';
import { runStudyArea } from '../studyAreaRun.ts';
import { DEFAULT_STUDY_AREA_ID, STUDY_AREAS } from '../registry/studyAreas.ts';

export const DEFAULT_ENVELOPE: Envelope = [-83.15, 42.41, -83.133, 42.426];

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DCI_DATA_DIR ? resolve(process.env.DCI_DATA_DIR) : resolve(here, '../../data');

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2);
      if (inline !== undefined) flags[name!] = inline;
      else if (rest[i + 1] !== undefined && !rest[i + 1]!.startsWith('--')) flags[name!] = rest[++i]!;
      else flags[name!] = true;
    } else positional.push(arg);
  }
  return { command, positional, flags };
}

function usage(): never {
  console.error(`usage:
  pnpm run fetch <source_id> [--envelope minLon,minLat,maxLon,maxLat | --no-envelope] [--where "<sql>"] [--force] [--no-skip]
  pnpm run fetch:study-area [study_area_id] [--only a,b,c] [--force]
  pnpm run diff <source_id>
  pnpm run health
  pnpm run manifest
sources: ${SOURCES.map((s) => s.id).join(', ')}
study areas: ${STUDY_AREAS.map((a) => a.id).join(', ')}
data dir: ${DATA_DIR} (override with DCI_DATA_DIR)`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const store = new SnapshotStore(DATA_DIR);
  const log = (message: string) => console.error(`[ingest] ${message}`);

  switch (command) {
    case 'fetch': {
      const id = positional[0];
      if (!id) usage();
      const source = getSource(id);
      const envelope = flags['no-envelope'] ? null : typeof flags.envelope === 'string' ? parseEnvelope(flags.envelope) : DEFAULT_ENVELOPE;
      const where = typeof flags.where === 'string' ? flags.where : null;
      const client = new FeatureServiceClient({ log });
      try {
        const result = await fetchSource(client, store, source, { envelope, where, force: flags.force === true, skipIfUnchanged: flags['no-skip'] !== true, log });
        const m = result.meta;
        console.log(
          JSON.stringify(
            {
              source_id: m.source_id,
              created: result.created,
              skipped: result.skipped,
              snapshot_id: m.snapshot_id,
              dir: result.dir,
              row_count: m.row_count,
              received_count: m.received_count,
              rejected_count: m.rejected_count,
              complete: m.complete,
              layer_last_edit: m.layer_last_edit,
              fetched_at: m.fetched_at,
              sha256: m.sha256,
              where: m.where,
              envelope: m.envelope,
              key_field: m.key_field,
              fields_dropped: m.fields_dropped,
              requests: result.requests,
            },
            null,
            2,
          ),
        );
        if (!result.created && !result.skipped) log(`${source.id}: identical to latest snapshot ${m.snapshot_id}; nothing written (use --force to write anyway)`);
      } catch (error) {
        store.writeLastError(source.id, { at: new Date().toISOString(), message: (error as Error).message });
        throw error;
      }
      return;
    }
    case 'fetch-study-area': {
      const studyAreaId = positional[0] ?? DEFAULT_STUDY_AREA_ID;
      const only = typeof flags.only === 'string' ? flags.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const report = await runStudyArea({ studyAreaId, dataDir: DATA_DIR, force: flags.force === true, log, ...(only ? { only } : {}) });
      const table = report.sources.map((r) => ({
        source: r.source_id,
        scope: r.scope,
        status: r.status,
        rows: r.row_count,
        received: r.received_count,
        out_of_scope: r.out_of_scope,
        city_updated: r.layer_last_edit,
        fetched: r.fetched_at,
        diff: r.diff === null ? '' : typeof r.diff === 'string' ? r.diff : `+${r.diff.added} -${r.diff.removed} ~${r.diff.modified_rows}`,
        requests: r.requests,
        seconds: r.seconds,
        error: r.error ?? '',
      }));
      console.error(`[ingest] study area ${report.study_area.name} (${report.study_area.id}), ${report.started_at} -> ${report.finished_at}`);
      console.table(table);
      console.log(JSON.stringify(report, null, 2));
      if (report.sources.some((r) => r.status === 'failed')) process.exitCode = 1;
      return;
    }
    case 'diff': {
      const id = positional[0];
      if (!id) usage();
      getSource(id);
      const outcome = diffLatest(store, new ChangeStore(DATA_DIR), id);
      if (outcome.status === 'diffed') {
        const { changes, ...rest } = outcome.summary;
        console.log(JSON.stringify({ status: 'diffed', file: outcome.file, ...rest, change_count: changes.length }, null, 2));
      } else console.log(JSON.stringify(outcome, null, 2));
      return;
    }
    case 'health': {
      const { file, health } = writeHealth(store, SOURCES);
      log(`wrote ${file}`);
      console.log(JSON.stringify(health, null, 2));
      return;
    }
    case 'manifest': {
      const { file, manifest } = writeManifest(store, SOURCES);
      log(`wrote ${file}`);
      console.log(JSON.stringify(manifest, null, 2));
      return;
    }
    default:
      usage();
  }
}

main().catch((error: unknown) => {
  console.error(`[ingest] failed: ${(error as Error).stack ?? String(error)}`);
  process.exit(1);
});
