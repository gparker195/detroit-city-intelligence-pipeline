/**
 * Shared HTTP layer for the civic connectors.
 *
 * - Identifying User-Agent on every request.
 * - Global ceiling of one request start every `minIntervalMs` (default 2000 ms = 1 request / 2 s).
 * - robots.txt is fetched and honored per host before any page read; a disallow stops the run.
 * - Any bot challenge (Cloudflare "Just a moment", Akamai "Access Denied", HTTP 403/429/503 with
 *   challenge markers) raises BotChallengeError and the caller stops. Nothing here retries around it.
 *
 * Everything time-related is injectable so tests never sleep and never touch the network.
 */

export const USER_AGENT = 'DetroitCityIntelligence/0.1 (+https://github.com/gparker195/detroit-city-intelligence-pipeline)';

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<FetchResponseLike>;

export interface HttpOptions {
  fetchImpl?: FetchLike;
  userAgent?: string;
  /** Minimum ms between request starts. Default 2000. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
  /** Skip robots.txt (only for APIs that document themselves as open, e.g. USAspending). */
  ignoreRobots?: boolean;
}

export class HttpError extends Error {
  readonly status: number; readonly url: string; readonly body: string;
  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 160)}`);
    this.status = status; this.url = url; this.body = body;
  }
}
export class BotChallengeError extends Error {
  readonly url: string; readonly status: number; readonly marker: string;
  constructor(url: string, status: number, marker: string) {
    super(`Bot challenge or access denial at ${url} (HTTP ${status}: ${marker}); stopping, not bypassing.`);
    this.url = url; this.status = status; this.marker = marker;
  }
}
export class RobotsDisallowedError extends Error {
  readonly url: string; readonly rule: string;
  constructor(url: string, rule: string) {
    super(`robots.txt disallows ${url} (rule: ${rule}); stopping.`);
    this.url = url; this.rule = rule;
  }
}

/** Interstitial challenge pages (served with any status). A normally served Cloudflare page also
 *  references /cdn-cgi/challenge-platform/ scripts, so only the interstitial's own text counts. */
const CHALLENGE_MARKERS = ['<title>Just a moment...</title>', 'Just a moment...', 'Performing security verification', 'Attention Required! | Cloudflare'];

export function detectChallenge(status: number, body: string): string | null {
  for (const m of CHALLENGE_MARKERS) if (body.includes(m)) return m;
  if (status === 403) return body.includes('Access Denied') ? 'HTTP 403 Access Denied' : 'HTTP 403';
  if (status === 429 || status === 503) return `HTTP ${status}`;
  return null;
}

/** Minimal robots.txt evaluator: longest-match Allow/Disallow for the matching agent group. */
export interface RobotsRules { agent: string; allow: string[]; disallow: string[]; crawlDelayMs: number | null }

export function parseRobots(text: string, productToken = 'DetroitCityIntelligence'): RobotsRules {
  const groups: { agents: string[]; allow: string[]; disallow: string[]; crawlDelay: number | null }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], allow: [], disallow: [], crawlDelay: null }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow' && val) cur.allow.push(val);
    else if (key === 'disallow') { if (val) cur.disallow.push(val); }
    else if (key === 'crawl-delay') { const n = Number(val); if (Number.isFinite(n)) cur.crawlDelay = n; }
  }
  const token = productToken.toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const star = groups.find((g) => g.agents.includes('*'));
  const g = specific ?? star;
  if (!g) return { agent: '(none)', allow: [], disallow: [], crawlDelayMs: null };
  return { agent: specific ? token : '*', allow: g.allow, disallow: g.disallow, crawlDelayMs: g.crawlDelay == null ? null : g.crawlDelay * 1000 };
}

function ruleMatches(rule: string, path: string): boolean {
  // Support '*' wildcard and '$' end anchor as in Google's robots spec.
  const esc = rule.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  const anchored = esc.endsWith('\\$') ? `^${esc.slice(0, -2)}$` : `^${esc}`;
  return new RegExp(anchored).test(path);
}

/** Returns the disallow rule that blocks `path`, or null if allowed. */
export function robotsBlocks(rules: RobotsRules, path: string): string | null {
  let best: { len: number; allow: boolean; rule: string } | null = null;
  for (const r of rules.allow) if (ruleMatches(r, path) && (!best || r.length > best.len)) best = { len: r.length, allow: true, rule: r };
  for (const r of rules.disallow) if (ruleMatches(r, path) && (!best || r.length > best.len)) best = { len: r.length, allow: false, rule: r };
  return best && !best.allow ? best.rule : null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly ignoreRobots: boolean;
  private lastStart = -Infinity;
  private readonly robotsCache = new Map<string, RobotsRules>();

  constructor(opts: HttpOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchResponseLike>);
    this.userAgent = opts.userAgent ?? USER_AGENT;
    this.minIntervalMs = opts.minIntervalMs ?? 2000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.ignoreRobots = opts.ignoreRobots ?? false;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastStart + this.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastStart = this.now();
  }

  private async rawRequest(url: string, init?: Parameters<FetchLike>[1]): Promise<FetchResponseLike> {
    await this.throttle();
    this.log(`${init?.method ?? 'GET'} ${url}`);
    return this.fetchImpl(url, { ...init, headers: { 'User-Agent': this.userAgent, Accept: '*/*', ...(init?.headers ?? {}) } });
  }

  async robotsFor(url: string): Promise<RobotsRules> {
    const u = new URL(url);
    const key = u.origin;
    const cached = this.robotsCache.get(key);
    if (cached) return cached;
    const res = await this.rawRequest(`${key}/robots.txt`);
    const body = await res.text();
    // RFC 9309 s2.3.1.3: an unavailable robots.txt (4xx) imposes no restrictions; the page request
    // itself is still subject to challenge/denial detection. An interstitial challenge body stops us.
    const marker = detectChallenge(res.status, body);
    if (marker && res.status < 400) throw new BotChallengeError(`${key}/robots.txt`, res.status, marker);
    if (res.status >= 500) throw new HttpError(res.status, `${key}/robots.txt`, body);
    const rules = res.status === 200 ? parseRobots(body) : { agent: '(none)', allow: [], disallow: [], crawlDelayMs: null };
    if (rules.crawlDelayMs && rules.crawlDelayMs > this.minIntervalMs) this.minIntervalMs = rules.crawlDelayMs;
    this.robotsCache.set(key, rules);
    return rules;
  }

  async assertAllowed(url: string): Promise<void> {
    if (this.ignoreRobots) return;
    const rules = await this.robotsFor(url);
    const u = new URL(url);
    const blocked = robotsBlocks(rules, u.pathname + u.search);
    if (blocked) throw new RobotsDisallowedError(url, blocked);
  }

  async get(url: string, headers?: Record<string, string>): Promise<{ status: number; headers: FetchResponseLike['headers']; text: string }> {
    await this.assertAllowed(url);
    const res = await this.rawRequest(url, headers ? { headers } : {});
    const text = await res.text();
    const marker = detectChallenge(res.status, text);
    if (marker) throw new BotChallengeError(url, res.status, marker);
    if (!res.ok) throw new HttpError(res.status, url, text);
    return { status: res.status, headers: res.headers, text };
  }

  async getBytes(url: string): Promise<{ status: number; headers: FetchResponseLike['headers']; bytes: Uint8Array }> {
    await this.assertAllowed(url);
    const res = await this.rawRequest(url);
    if (!res.ok) {
      const text = await res.text();
      const marker = detectChallenge(res.status, text);
      if (marker) throw new BotChallengeError(url, res.status, marker);
      throw new HttpError(res.status, url, text);
    }
    return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
  }

  async postJson<T>(url: string, body: unknown): Promise<T> {
    await this.assertAllowed(url);
    const res = await this.rawRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    const marker = detectChallenge(res.status, text);
    if (marker) throw new BotChallengeError(url, res.status, marker);
    if (!res.ok) throw new HttpError(res.status, url, text);
    return JSON.parse(text) as T;
  }
}
