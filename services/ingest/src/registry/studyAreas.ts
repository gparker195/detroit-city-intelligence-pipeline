/**
 * Study areas are official polygons taken from a registered source, never hand-drawn boxes.
 * v0: the SNF area "Livernois / McNichols" (item dafad9fc0e854d9fb03d9cb00ea5e69c, Proj_NAME).
 * Point feeds are scoped to the polygon plus `buffer_m`.
 */

import type { SnapshotStore } from '../snapshot/store.ts';
import { ringsBbox, type Ring } from '../util/geo.ts';
import type { Envelope } from '../arcgis/featureServiceClient.ts';

export interface StudyAreaDefinition {
  id: string;
  name: string;
  source_id: string;
  match: { field: string; value: string };
  buffer_m: number;
}

export const STUDY_AREAS: readonly StudyAreaDefinition[] = [
  {
    id: 'livernois-mcnichols',
    name: 'Livernois / McNichols',
    source_id: 'snf',
    match: { field: 'Proj_NAME', value: 'Livernois / McNichols' },
    buffer_m: 300,
  },
];

export const DEFAULT_STUDY_AREA_ID = 'livernois-mcnichols';

export function getStudyArea(id: string): StudyAreaDefinition {
  const area = STUDY_AREAS.find((a) => a.id === id);
  if (!area) throw new Error(`unknown study area "${id}"; known: ${STUDY_AREAS.map((a) => a.id).join(', ')}`);
  return area;
}

export interface ResolvedStudyArea extends StudyAreaDefinition {
  rings: Ring[];
  bbox: Envelope;
  source_snapshot_id: string;
  source_key: string;
}

/** Reads the study-area polygon from the latest snapshot of its source. */
export function resolveStudyArea(store: SnapshotStore, def: StudyAreaDefinition): ResolvedStudyArea {
  const latest = store.readLatest(def.source_id);
  if (!latest) throw new Error(`study area ${def.id}: no snapshot of ${def.source_id} yet; fetch it first`);
  const records = store.readRecords(def.source_id, latest.snapshot_id);
  const hit = records.find((r) => String(r.attributes[def.match.field] ?? '').trim() === def.match.value);
  if (!hit) throw new Error(`study area ${def.id}: no ${def.source_id} row with ${def.match.field} = "${def.match.value}"`);
  const geometry = hit.geometry as { rings?: Ring[] } | null;
  if (!geometry?.rings?.length) throw new Error(`study area ${def.id}: matched row has no polygon geometry`);
  return { ...def, rings: geometry.rings, bbox: ringsBbox(geometry.rings), source_snapshot_id: latest.snapshot_id, source_key: hit.key };
}
