/**
 * Bonfire open-opportunities reader. Order of operations, enforced:
 *   1. robots.txt for detroit.bonfirehub.com is fetched and evaluated for /portal/?tab=openOpportunities.
 *      Verified 2026-09-21: it is `User-agent: * / Disallow: /`, so the connector stops here.
 *   2. Only if allowed: load the page once in Playwright, watch network responses for a JSON endpoint
 *      that carries the table (preferred), else read the rendered table's cells.
 * The DOM/JSON extraction is kept small and only ever runs after step 1 passes.
 */
import type { HttpClient } from '../util/http.ts';
import { openBrowser } from '../util/browser.ts';
import type { BonfireRow } from './normalize.ts';

export const BONFIRE_OPEN_URL = 'https://detroit.bonfirehub.com/portal/?tab=openOpportunities';

export interface BonfireCapture { mode: 'json' | 'dom'; endpoint: string | null; rows: BonfireRow[]; html: string; json: unknown | null }

export async function captureOpenOpportunities(http: HttpClient): Promise<BonfireCapture> {
  await http.assertAllowed(BONFIRE_OPEN_URL); // throws RobotsDisallowedError when disallowed
  const session = await openBrowser(http);
  const jsonHits: { url: string; body: unknown }[] = [];
  session.page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] ?? '';
      if (ct.includes('application/json') && /opportunit|project|portal/i.test(res.url())) jsonHits.push({ url: res.url(), body: await res.json() });
    } catch { /* ignore */ }
  });
  try {
    const { html } = await session.goto(BONFIRE_OPEN_URL);
    await session.page.waitForTimeout(3000);
    const jsonHit = jsonHits.find((h) => Array.isArray(h.body) || (h.body && typeof h.body === 'object' && Object.values(h.body as object).some(Array.isArray)));
    if (jsonHit) {
      const arr = (Array.isArray(jsonHit.body) ? jsonHit.body : Object.values(jsonHit.body as object).find(Array.isArray)) as Record<string, unknown>[];
      const rows = arr.map((o) => ({
        ref: String(o['referenceNumber'] ?? o['ref'] ?? o['reference'] ?? ''),
        title: String(o['name'] ?? o['title'] ?? o['projectName'] ?? ''),
        department: String(o['department'] ?? o['departmentName'] ?? ''),
        close_at: String(o['closeDate'] ?? o['closingDate'] ?? o['dateClose'] ?? ''),
        days_left: String(o['daysLeft'] ?? ''),
        url: typeof o['url'] === 'string' ? (o['url'] as string) : (o['id'] ? `https://detroit.bonfirehub.com/opportunities/${o['id']}` : BONFIRE_OPEN_URL),
      })).filter((r) => r.ref || r.title);
      return { mode: 'json', endpoint: jsonHit.url, rows, html, json: jsonHit.body };
    }
    const rows = await session.page.$$eval('table tr', (trs) => trs.map((tr) => {
      const tds = Array.from(tr.querySelectorAll('td')).map((td) => (td as HTMLElement).innerText.trim());
      const a = tr.querySelector('a[href*="/opportunities/"]') as HTMLAnchorElement | null;
      return { tds, href: a?.href ?? '' };
    }).filter((r) => r.tds.length >= 5));
    return { mode: 'dom', endpoint: null, html, json: null, rows: rows.map((r) => ({ ref: r.tds[0] ?? '', title: r.tds[1] ?? '', department: r.tds[2] ?? '', close_at: r.tds[3] ?? '', days_left: r.tds[4] ?? '', url: r.href })) };
  } finally {
    await session.close();
  }
}
