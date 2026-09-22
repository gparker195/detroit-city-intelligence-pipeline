/**
 * pnpm run usaspending [--cap 500] [--fy 2026,2025] [--group contracts|grants]
 * Weekly cadence. Writes data/raw/usaspending/*.json (one per page), data/normalized/usaspending.ndjson, manifest.
 */
import { HttpClient } from '../util/http.ts';
import { writeRaw, writeNdjson, updateManifest, rawRef } from '../util/archive.ts';
import { fetchAwards, currentFiscalYear, type AwardGroup } from './client.ts';
import { normalizePages } from './normalize.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] ?? d : d; };
const cap = Number(opt('--cap', '500'));
const fyNow = currentFiscalYear(new Date());
const fiscalYears = opt('--fy', `${fyNow},${fyNow - 1}`).split(',').map(Number);
const groupArg = opt('--group', '');
const groups = groupArg ? [groupArg as AwardGroup] : (['contracts', 'grants'] as AwardGroup[]);
const queries = fiscalYears.length * groups.length;
const capPerQuery = Math.max(1, Math.ceil(cap / queries));

const http = new HttpClient({ ignoreRobots: true, minIntervalMs: 2000, log: (m) => console.error(m) });
const observed_at = new Date().toISOString();
const pages = await fetchAwards(http, { fiscalYears, groups, capPerQuery, log: (m) => console.error(m) });
const raw = pages.map((p) => writeRaw('usaspending', `fy${p.fy}_${p.group}_p${p.page}.json`, JSON.stringify({ request: p.request, response: p.response }, null, 2), { url: 'https://api.usaspending.gov/api/v2/search/spending_by_award/', source_updated: null, content_type: 'application/json', fetched_at: observed_at }));
const { records, duplicates } = normalizePages(pages, observed_at);
const normalized_path = writeNdjson('usaspending', records);
updateManifest({ source_id: 'usaspending', fetched_at: observed_at, source_updated: null, records: records.length, normalized_path, raw: raw.map(rawRef), status: 'ok', note: `cap ${cap}; ${queries} queries; ${duplicates} duplicate award ids dropped; USAspending does not publish a dataset-level updated date on this endpoint` });
const byGroup: Record<string, number> = {};
for (const r of records) byGroup[`FY${r.fiscal_year} ${r.award_group}`] = (byGroup[`FY${r.fiscal_year} ${r.award_group}`] ?? 0) + 1;
console.log(JSON.stringify({ source_id: 'usaspending', fetched_at: observed_at, pages: pages.length, records: records.length, duplicates, byGroup, examples: records.slice(0, 3) }, null, 2));
