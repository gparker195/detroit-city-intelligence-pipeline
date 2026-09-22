import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HttpClient, parseRobots, robotsBlocks, RobotsDisallowedError, BotChallengeError, detectChallenge, USER_AGENT } from '../src/util/http.ts';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const resp = (status: number, body: string, headers: Record<string, string> = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer });

test('robots: Bonfire "Disallow: /" blocks everything', () => {
  const rules = parseRobots(fx('robots-bonfire.txt'));
  assert.equal(robotsBlocks(rules, '/portal/?tab=openOpportunities'), '/');
});
test('robots: detroitvotes allows /early/, blocks /wp-admin/, carries crawl-delay', () => {
  const rules = parseRobots(fx('robots-detroitvotes.txt'));
  assert.equal(robotsBlocks(rules, '/early/'), null);
  assert.equal(robotsBlocks(rules, '/wp-admin/x'), '/wp-admin/');
  assert.equal(robotsBlocks(rules, '/wp-admin/admin-ajax.php'), null);
  assert.equal(rules.crawlDelayMs, 10000);
});
test('client: robots disallow stops before the page request, UA and spacing are enforced', async () => {
  const calls: { url: string; ua: string | undefined; t: number }[] = [];
  let now = 0;
  const http = new HttpClient({ now: () => now, sleep: async (ms) => { now += ms; }, minIntervalMs: 2000,
    fetchImpl: async (url, init) => { calls.push({ url, ua: init?.headers?.['User-Agent'], t: now }); return url.endsWith('/robots.txt') ? resp(200, fx('robots-bonfire.txt')) : resp(200, '<html>'); } });
  await assert.rejects(http.get('https://detroit.bonfirehub.com/portal/?tab=openOpportunities'), RobotsDisallowedError);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.ua, USER_AGENT);
  const http2 = new HttpClient({ now: () => now, sleep: async (ms) => { now += ms; }, minIntervalMs: 2000, ignoreRobots: true, fetchImpl: async (url) => { calls.push({ url, ua: undefined, t: now }); return resp(200, 'ok'); } });
  await http2.get('https://example.gov/a'); await http2.get('https://example.gov/b');
  assert.ok(calls[2]!.t - calls[1]!.t >= 2000, 'second request waits at least 2 s');
});
test('client: crawl-delay above the floor raises the interval', async () => {
  let now = 0; const starts: number[] = [];
  const http = new HttpClient({ now: () => now, sleep: async (ms) => { now += ms; }, minIntervalMs: 2000, fetchImpl: async (url) => { starts.push(now); return url.endsWith('/robots.txt') ? resp(200, fx('robots-detroitvotes.txt')) : resp(200, 'ok'); } });
  await http.get('https://detroitvotes.org/early/'); await http.get('https://detroitvotes.org/home/');
  assert.ok(starts[2]! - starts[1]! >= 10000);
});
test('client: bot challenge bodies stop the run', async () => {
  const http = new HttpClient({ ignoreRobots: true, sleep: async () => {}, fetchImpl: async () => resp(403, '<title>Just a moment...</title>') });
  await assert.rejects(http.get('https://detroitmi.gov/departments/elections'), BotChallengeError);
  assert.equal(detectChallenge(403, '<h1>Access Denied</h1>'), 'HTTP 403 Access Denied');
  assert.equal(detectChallenge(200, 'fine'), null);
  assert.equal(detectChallenge(200, '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>'), null, 'a normally served Cloudflare page is not a challenge');
});
