/** City awardee layers (Motor City Match Cash Awardees, MCRS Awardees) via ArcGIS FeatureServer, resolved from the item. */
import type { HttpClient } from '../util/http.ts';

export const AWARDEE_ITEMS = [
  { source_id: 'mcm-cash-awardees', item_id: '76e09cb0417a452aba99608ccf40f116', program_id: 'motor-city-match' },
  { source_id: 'mcrs-awardees', item_id: '4a7517c0e46144e5a386e4ef41502110', program_id: 'motor-city-re-store' },
] as const;

export interface AwardeePoint {
  awardee_id: string;
  program_id: string;
  round: string | null;
  track: string | null;
  business: string | null;
  business_address: string | null;
  description: string | null;
  url: string | null;
  parcelno: string | null;
  lon: number | null;
  lat: number | null;
  vintage: { layer_last_edit: string | null; item_modified: string | null; item_created: string | null; stale_warning: string };
  source_id: string;
  source_url: string;
  observed_at: string;
  limitations: string[];
}
export const AWARDEE_LIMITATIONS = ['A past awardee point shows where an earlier round landed; it is not a current program status and the layer vintage is stale.'];

export interface ItemInfo { title: string; url: string; modified: number; created: number }
export interface LayerInfo { editingInfo?: { lastEditDate?: number; dataLastEditDate?: number }; geometryType?: string }
export interface GeoJsonFC { features: { id?: number | string; geometry: { type: string; coordinates: number[] } | null; properties: Record<string, unknown> }[] }

const iso = (ms: number | undefined | null) => (typeof ms === 'number' ? new Date(ms).toISOString() : null);
const s = (v: unknown) => (v == null || v === '' ? null : String(v));

export function normalizeAwardees(fc: GeoJsonFC, meta: { source_id: string; program_id: string; item: ItemInfo; layer: LayerInfo; layer_url: string; observed_at: string }): AwardeePoint[] {
  const lastEdit = iso(meta.layer.editingInfo?.dataLastEditDate ?? meta.layer.editingInfo?.lastEditDate);
  const vintage = { layer_last_edit: lastEdit, item_modified: iso(meta.item.modified), item_created: iso(meta.item.created), stale_warning: `Layer last edited ${lastEdit?.slice(0, 10) ?? 'unknown'}; shows past rounds only.` };
  return fc.features.map((f) => {
    const p = f.properties;
    const oid = f.id ?? p['ObjectId'] ?? p['OBJECTID'];
    return {
      awardee_id: `${meta.source_id}:${oid}`,
      program_id: meta.program_id,
      round: s(p['round']), track: s(p['track']), business: s(p['business']), business_address: s(p['business_address']),
      description: s(p['description']), url: s(p['url']), parcelno: s(p['parcelno']),
      lon: f.geometry?.type === 'Point' ? f.geometry.coordinates[0] ?? null : null,
      lat: f.geometry?.type === 'Point' ? f.geometry.coordinates[1] ?? null : null,
      vintage, source_id: meta.source_id, source_url: meta.layer_url, observed_at: meta.observed_at, limitations: [...AWARDEE_LIMITATIONS],
    };
  }).sort((a, b) => a.awardee_id.localeCompare(b.awardee_id));
}

export async function fetchAwardeeLayer(http: HttpClient, item_id: string): Promise<{ item: ItemInfo; layer: LayerInfo; layer_url: string; fc: GeoJsonFC; raw: { item: string; layer: string; query: string } }> {
  const itemRes = await http.get(`https://www.arcgis.com/sharing/rest/content/items/${item_id}?f=json`);
  const item = JSON.parse(itemRes.text) as ItemInfo & { url?: string };
  if (!item.url) throw new Error(`item ${item_id} has no service url`);
  const layer_url = `${item.url.replace(/\/$/, '')}/0`;
  const layerRes = await http.get(`${layer_url}?f=json`);
  const queryRes = await http.get(`${layer_url}/query?where=1%3D1&outFields=*&outSR=4326&f=geojson`);
  return { item, layer: JSON.parse(layerRes.text) as LayerInfo, layer_url, fc: JSON.parse(queryRes.text) as GeoJsonFC, raw: { item: itemRes.text, layer: layerRes.text, query: queryRes.text } };
}
