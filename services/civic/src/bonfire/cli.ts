/** pnpm run bonfire  — daily cadence. Stops (exit 2) when robots.txt disallows or a bot challenge appears. */
import { HttpClient, RobotsDisallowedError, BotChallengeError } from '../util/http.ts';
import { writeRaw, writeNdjson, updateManifest, rawRef } from '../util/archive.ts';
import { captureOpenOpportunities, BONFIRE_OPEN_URL } from './fetch.ts';
import { normalizeRow } from './normalize.ts';

const http = new HttpClient({ minIntervalMs: 2000, log: (m) => console.error(m) });
const observed_at = new Date().toISOString();
try {
  const cap = await captureOpenOpportunities(http);
  const raw = [writeRaw('bonfire', 'open-opportunities.html', cap.html, { url: BONFIRE_OPEN_URL, source_updated: null, content_type: 'text/html', fetched_at: observed_at })];
  if (cap.json) raw.push(writeRaw('bonfire', 'open-opportunities.json', JSON.stringify(cap.json, null, 2), { url: cap.endpoint ?? BONFIRE_OPEN_URL, source_updated: null, content_type: 'application/json', fetched_at: observed_at }));
  const records = cap.rows.map((r) => normalizeRow(r, observed_at));
  const normalized_path = writeNdjson('bonfire', records);
  updateManifest({ source_id: 'bonfire', fetched_at: observed_at, source_updated: null, records: records.length, normalized_path, raw: raw.map(rawRef), status: 'ok', note: `mode=${cap.mode}` });
  console.log(JSON.stringify({ source_id: 'bonfire', mode: cap.mode, endpoint: cap.endpoint, records: records.length, examples: records.slice(0, 5) }, null, 2));
} catch (e) {
  if (e instanceof RobotsDisallowedError || e instanceof BotChallengeError) {
    const robotsRaw = await (async () => { try { const r = await fetch('https://detroit.bonfirehub.com/robots.txt', { headers: { 'User-Agent': 'DetroitCityIntelligence/0.1 (+https://github.com/gparker195/detroit-city-intelligence-pipeline)' } }); return await r.text(); } catch { return null; } })();
    const raw = robotsRaw ? [rawRef(writeRaw('bonfire', 'robots.txt', robotsRaw, { url: 'https://detroit.bonfirehub.com/robots.txt', source_updated: null, content_type: 'text/plain', fetched_at: observed_at }))] : [];
    updateManifest({ source_id: 'bonfire', fetched_at: observed_at, source_updated: null, records: 0, normalized_path: '', raw, status: 'blocked', note: e.message });
    console.log(JSON.stringify({ source_id: 'bonfire', status: 'blocked', reason: e.message, robots_txt: robotsRaw }, null, 2));
    process.exit(2);
  }
  throw e;
}
