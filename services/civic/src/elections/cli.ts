/** pnpm run elections — weekly; daily within 45 days of the election. */
import { readFileSync } from 'node:fs';
import { HttpClient, BotChallengeError, RobotsDisallowedError } from '../util/http.ts';
import { writeRaw, writeNdjson, updateManifest, rawRef } from '../util/archive.ts';
import { packToRecords, parseSites, cadenceFor, type Pack, type ElectionRecord } from './normalize.ts';

const EARLY_URL = 'https://detroitvotes.org/early/';
const pack = JSON.parse(readFileSync(new URL('./pack.json', import.meta.url), 'utf8')) as Pack;
const observed_at = new Date().toISOString();
const log = (m: string) => console.error(m);
const http = new HttpClient({ minIntervalMs: 2000, log }); // robots.txt Crawl-delay (10 s on detroitvotes.org) is honored automatically
const records: ElectionRecord[] = packToRecords(pack, observed_at);
const raws = [rawRef(writeRaw('elections', 'pack.json', JSON.stringify(pack, null, 2), { url: 'file://services/civic/src/elections/pack.json', source_updated: pack.pack_version, content_type: 'application/json', fetched_at: observed_at }))];
let status: 'ok' | 'blocked' | 'partial' = 'ok'; let note = '';
let sitesCount = 0; let lastModified: string | null = null;
try {
  const res = await http.get(EARLY_URL);
  lastModified = res.headers.get('last-modified');
  const r = writeRaw('elections', 'detroitvotes-early.html', res.text, { url: EARLY_URL, source_updated: lastModified ? new Date(lastModified).toISOString() : null, content_type: 'text/html', fetched_at: observed_at });
  raws.push(rawRef(r));
  const sites = parseSites(res.text, { election_date: pack.election_date, verified_on: observed_at.slice(0, 10), observed_at, official_url: EARLY_URL });
  sitesCount = sites.length;
  records.push(...sites);
} catch (e) {
  if (e instanceof BotChallengeError || e instanceof RobotsDisallowedError) { status = 'partial'; note = `sites not refreshed: ${e.message}`; log(note); } else throw e;
}
const normalized_path = writeNdjson('elections', records);
updateManifest({ source_id: 'elections', fetched_at: observed_at, source_updated: pack.verified_on, records: records.length, normalized_path, raw: raws, status, note: note || `pack ${pack.pack_version}; ${pack.rules.length} rules, ${pack.link_outs.length} link-outs, ${sitesCount} sites; cadence now: ${cadenceFor(pack.election_date, new Date())}` });
const sites = records.filter((r) => r.record_type === 'site');
console.log(JSON.stringify({ source_id: 'elections', status, election: pack.election_name, cadence_now: cadenceFor(pack.election_date, new Date()), rules: pack.rules.length, link_outs: pack.link_outs.length, sites: sitesCount, early_vote_centers: sites.filter((s) => s.record_type === 'site' && s.roles.includes('early_vote_center')).map((s) => s.record_type === 'site' ? `${s.name} — ${s.address_as_published} — ${s.status_as_published}` : ''), drop_boxes: sites.filter((s) => s.record_type === 'site' && s.roles.includes('drop_box')).length, example_rule: records[0] }, null, 2));
