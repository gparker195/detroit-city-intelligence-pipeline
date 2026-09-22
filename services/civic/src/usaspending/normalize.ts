import type { AwardGroup, RawAward } from './client.ts';

export interface Agreement {
  agreement_id: string;
  level: 'federal';
  award_group: AwardGroup;
  award_id: string | null;
  recipient: string | null;
  amount: number | null;
  agency: string | null;
  sub_agency: string | null;
  start: string | null;
  end: string | null;
  description: string | null;
  place_of_performance: Record<string, unknown> | null;
  fiscal_year: number;
  source_id: 'usaspending';
  source_url: string;
  observed_at: string;
  limitations: string[];
}

export const AGREEMENT_LIMITATIONS = ['A federal award records money obligated, not work performed.'];

function str(v: unknown): string | null { return typeof v === 'string' && v.trim() ? v.trim() : null; }
function num(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

/** The endpoint returns a coded city ('MI22000' = Detroit) rather than a name; kept as `city_code`. */
function placeOfPerformance(raw: RawAward): Record<string, unknown> | null {
  if (raw.place_of_performance && typeof raw.place_of_performance === 'object') return raw.place_of_performance;
  const o: Record<string, unknown> = {};
  const map: [string, string][] = [['Place of Performance City Code', 'city_code'], ['Place of Performance State Code', 'state_code'], ['Place of Performance Country Code', 'country_code'], ['Place of Performance Zip5', 'zip5']];
  for (const [k, v] of map) { const val = raw[k]; if (val != null && val !== '') o[v] = val; }
  return Object.keys(o).length ? o : null;
}

export function normalizeAward(raw: RawAward, ctx: { fy: number; group: AwardGroup; observed_at: string }): Agreement {
  const id = str(raw.generated_internal_id) ?? str(raw['Award ID']) ?? `internal:${raw.internal_id ?? 'unknown'}`;
  return {
    agreement_id: id,
    level: 'federal',
    award_group: ctx.group,
    award_id: str(raw['Award ID']),
    recipient: str(raw['Recipient Name']),
    amount: num(raw['Award Amount']),
    agency: str(raw['Awarding Agency']),
    sub_agency: str(raw['Awarding Sub Agency']),
    start: str(raw['Start Date']),
    end: str(raw['End Date']),
    description: str(raw.Description),
    place_of_performance: placeOfPerformance(raw),
    fiscal_year: ctx.fy,
    source_id: 'usaspending',
    source_url: str(raw.generated_internal_id) ? `https://www.usaspending.gov/award/${raw.generated_internal_id}` : 'https://www.usaspending.gov/',
    observed_at: ctx.observed_at,
    limitations: [...AGREEMENT_LIMITATIONS],
  };
}

/** Normalize pages and drop exact duplicate agreement_ids (the API can repeat an award across pages). */
export function normalizePages(pages: { fy: number; group: AwardGroup; response: { results: RawAward[] } }[], observed_at: string): { records: Agreement[]; duplicates: number } {
  const seen = new Set<string>();
  const records: Agreement[] = [];
  let duplicates = 0;
  for (const p of pages) {
    for (const raw of p.response.results) {
      const rec = normalizeAward(raw, { fy: p.fy, group: p.group, observed_at });
      if (seen.has(rec.agreement_id)) { duplicates += 1; continue; }
      seen.add(rec.agreement_id);
      records.push(rec);
    }
  }
  records.sort((a, b) => a.agreement_id.localeCompare(b.agreement_id));
  return { records, duplicates };
}
