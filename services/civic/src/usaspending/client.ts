/**
 * USAspending API v2, spending_by_award (no key). Detroit, MI place of performance.
 * Docs: https://api.usaspending.gov/docs/endpoints (verified 2026-09-21: keyless POST works).
 */
import type { HttpClient } from '../util/http.ts';

export const USASPENDING_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
/** `place_of_performance` is accepted but returns null on this endpoint (observed 2026-09-21); the per-field
 *  Place of Performance columns are requested too and folded into one object by the normalizer. */
export const FIELDS = ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Awarding Sub Agency', 'Start Date', 'End Date', 'Description', 'place_of_performance', 'Place of Performance City Code', 'Place of Performance State Code', 'Place of Performance Country Code', 'Place of Performance Zip5'] as const;
export const AWARD_GROUPS = { contracts: ['A', 'B', 'C', 'D'], grants: ['02', '03', '04', '05'] } as const;
export type AwardGroup = keyof typeof AWARD_GROUPS;

export interface RawAward {
  internal_id?: number;
  generated_internal_id?: string;
  'Award ID'?: string | null;
  'Recipient Name'?: string | null;
  'Award Amount'?: number | null;
  'Awarding Agency'?: string | null;
  'Awarding Sub Agency'?: string | null;
  'Start Date'?: string | null;
  'End Date'?: string | null;
  Description?: string | null;
  place_of_performance?: Record<string, unknown> | null;
  [k: string]: unknown;
}
export interface SearchResponse { results: RawAward[]; page_metadata: { page: number; hasNext: boolean }; messages?: string[] }

/** Federal fiscal year N runs Oct 1 (N-1) .. Sep 30 N. */
export function fiscalYearRange(fy: number): { start_date: string; end_date: string } {
  return { start_date: `${fy - 1}-10-01`, end_date: `${fy}-09-30` };
}
export function currentFiscalYear(today: Date): number {
  return today.getUTCMonth() >= 9 ? today.getUTCFullYear() + 1 : today.getUTCFullYear();
}

export function buildRequest(fy: number, group: AwardGroup, page: number, limit: number) {
  return {
    filters: {
      time_period: [fiscalYearRange(fy)],
      award_type_codes: [...AWARD_GROUPS[group]],
      place_of_performance_locations: [{ country: 'USA', state: 'MI', city: 'Detroit' }],
    },
    fields: [...FIELDS],
    limit,
    page,
    sort: 'Award Amount',
    order: 'desc',
    subawards: false,
  };
}

export interface PageResult { fy: number; group: AwardGroup; page: number; request: unknown; response: SearchResponse }

export async function fetchAwards(http: HttpClient, opts: { fiscalYears: number[]; groups?: AwardGroup[]; capPerQuery: number; pageSize?: number; log?: (m: string) => void }): Promise<PageResult[]> {
  const pageSize = Math.min(opts.pageSize ?? 100, 100);
  const groups = opts.groups ?? (Object.keys(AWARD_GROUPS) as AwardGroup[]);
  const out: PageResult[] = [];
  for (const fy of opts.fiscalYears) {
    for (const group of groups) {
      let page = 1; let got = 0;
      for (;;) {
        const request = buildRequest(fy, group, page, Math.min(pageSize, opts.capPerQuery - got));
        const response = await http.postJson<SearchResponse>(USASPENDING_URL, request);
        out.push({ fy, group, page, request, response });
        got += response.results.length;
        opts.log?.(`usaspending FY${fy} ${group} page ${page}: ${response.results.length} rows (total ${got})`);
        if (!response.page_metadata?.hasNext || got >= opts.capPerQuery || response.results.length === 0) break;
        page += 1;
      }
    }
  }
  return out;
}
