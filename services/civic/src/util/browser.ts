/**
 * Playwright (Apache-2.0) helper for public pages that only serve real browsers (michigan.gov's
 * Akamai edge returns 403 to plain HTTP clients but 200 to a Chromium with our identifying UA).
 *
 * Rules: the honest User-Agent is always set; robots.txt is checked through HttpClient before any
 * navigation; if the served page is a bot challenge we stop. Downloads go through an in-page
 * `fetch` from an already-loaded page on the same origin so the browser's own TLS stack is used
 * and no header is forged. Rate: one navigation or fetch every 2 s.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { BotChallengeError, RobotsDisallowedError, USER_AGENT, detectChallenge, parseRobots, robotsBlocks, HttpClient, HttpError, type RobotsRules } from './http.ts';

export interface BrowserSession {
  page: Page;
  goto(url: string): Promise<{ status: number; text: string; html: string }>;
  fetchBytes(url: string): Promise<{ status: number; bytes: Uint8Array; lastModified: string | null; contentType: string | null }>;
  close(): Promise<void>;
}

export async function openBrowser(http: HttpClient, opts: { minIntervalMs?: number; headless?: boolean } = {}): Promise<BrowserSession> {
  const browser: Browser = await chromium.launch({ headless: opts.headless ?? true });
  const ctx: BrowserContext = await browser.newContext({ userAgent: USER_AGENT });
  const page = await ctx.newPage();
  const interval = opts.minIntervalMs ?? 2000;
  let last = 0;
  const throttle = async () => { const w = last + interval - Date.now(); if (w > 0) await new Promise((r) => setTimeout(r, w)); last = Date.now(); };
  const robotsCache = new Map<string, RobotsRules>();
  /** robots.txt read the same way the pages are read (the browser), so a host that denies plain
   *  HTTP clients but serves browsers is judged by the robots.txt it actually serves to us. */
  const assertAllowed = async (url: string) => {
    try { await http.assertAllowed(url); return; } catch (e) { if (!(e instanceof BotChallengeError || e instanceof HttpError)) throw e; }
    const origin = new URL(url).origin;
    let rules = robotsCache.get(origin);
    if (!rules) {
      await throttle();
      const res = await page.goto(`${origin}/robots.txt`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const status = res?.status() ?? 0;
      const body = await page.evaluate(() => document.body?.innerText ?? '');
      const marker = detectChallenge(status, body.slice(0, 2000));
      if (marker && status < 400) throw new BotChallengeError(`${origin}/robots.txt`, status, marker);
      rules = status === 200 ? parseRobots(body) : { agent: '(none)', allow: [], disallow: [], crawlDelayMs: null };
      robotsCache.set(origin, rules);
    }
    const u = new URL(url);
    const blocked = robotsBlocks(rules, u.pathname + u.search);
    if (blocked) throw new RobotsDisallowedError(url, blocked);
  };
  return {
    page,
    async goto(url) {
      await assertAllowed(url);
      await throttle();
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500);
      const status = res?.status() ?? 0;
      const text = await page.evaluate(() => document.body?.innerText ?? '');
      const html = await page.content();
      const marker = detectChallenge(status, text.slice(0, 2000));
      if (marker) throw new BotChallengeError(url, status, marker);
      return { status, text, html };
    },
    async fetchBytes(url) {
      await assertAllowed(url);
      await throttle();
      const r = await page.evaluate(async (u: string) => {
        const res = await fetch(u, { credentials: 'omit' });
        const buf = new Uint8Array(await res.arrayBuffer());
        return { status: res.status, lm: res.headers.get('last-modified'), ct: res.headers.get('content-type'), b: Array.from(buf) };
      }, url);
      const bytes = Uint8Array.from(r.b);
      if (r.status !== 200) {
        const marker = detectChallenge(r.status, Buffer.from(bytes).toString('utf8').slice(0, 2000));
        if (marker) throw new BotChallengeError(url, r.status, marker);
      }
      return { status: r.status, bytes, lastModified: r.lm, contentType: r.ct };
    },
    async close() { await browser.close(); },
  };
}
