/**
 * Discover 2026 "new/approved certificates" PDFs on the Treasury exemption-activity pages, and
 * download them through the browser session (michigan.gov's edge serves browsers only).
 */
import type { BrowserSession } from '../util/browser.ts';
import type { StcProgram } from './parse.ts';

export const STC_INDEX_PAGES: { program: StcProgram; url: string }[] = [
  { program: 'OPRA', url: 'https://www.michigan.gov/taxes/property/exemptions/community-development/obsolete-property-rehabilitation-act/folder/exemption-activity' },
  { program: 'IFT', url: 'https://www.michigan.gov/taxes/property/exemptions/business-and-industrial/industrial-facilities-exemption/folder/exemption-activity' },
  { program: 'CRA', url: 'https://www.michigan.gov/taxes/property/exemptions/community-development/commercial-rehabilitation-act/folder/exemption-activity' },
];

export interface PdfLink { program: StcProgram; label: string; url: string }

/** Pick certificate-list links for `year`: path contains /<year>/ or a -YY suffix, label/name says certificates, not amendments/transfers/revocations/dismissals. */
export function selectCertificateLinks(links: { label: string; href: string }[], program: StcProgram, year: number): PdfLink[] {
  const yy = String(year).slice(2);
  const out: PdfLink[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    const clean = l.href.split('?')[0]!;
    if (!/\.pdf$/i.test(clean)) continue;
    const name = clean.split('/').pop() ?? '';
    const otherYearFolder = (clean.match(/\/(20\d\d)(?:_20\d\d)?\//g) ?? []).some((f) => !f.includes(String(year)));
    const inYear = clean.includes(`/${year}/`) || new RegExp(`[-_]${yy}\\.pdf$`).test(name) || new RegExp(`[-_]\\d{1,2}-?\\d{1,2}-?${yy}\\b`).test(name) || new RegExp(`/${yy}\\)`).test(l.label);
    if (!inYear || otherYearFolder) continue;
    const isCert = /certificate/i.test(name) || /certificate/i.test(l.label);
    const isOther = /amend|transfer|revoc|dismiss|letter|form|guideline|memo/i.test(name) || /amend|transfer|revoc|dismiss/i.test(l.label);
    if (!isCert || isOther) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push({ program, label: l.label, url: l.href });
  }
  return out;
}

export async function discoverPdfs(session: BrowserSession, year: number, log: (m: string) => void): Promise<PdfLink[]> {
  const all: PdfLink[] = [];
  for (const idx of STC_INDEX_PAGES) {
    const { status } = await session.goto(idx.url);
    const links = await session.page.$$eval('a', (as) => as.map((a) => ({ label: (a.textContent ?? '').trim().replace(/\s+/g, ' '), href: (a as HTMLAnchorElement).href })));
    const picked = selectCertificateLinks(links, idx.program, year);
    log(`${idx.program} index ${status}: ${links.length} links, ${picked.length} ${year} certificate PDFs`);
    all.push(...picked);
  }
  return all;
}
