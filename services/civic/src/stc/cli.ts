/**
 * pnpm run stc [--year 2026] [--from-file <pdf> --program OPRA|IFT|CRA --url <official url>]
 * Monthly cadence. Discovers 2026 certificate PDFs, archives them, parses certificate pages, filters to Detroit.
 */
import { readFileSync } from 'node:fs';
import { HttpClient, BotChallengeError, RobotsDisallowedError } from '../util/http.ts';
import { openBrowser } from '../util/browser.ts';
import { writeRaw, writeNdjson, updateManifest, rawRef, sha256 } from '../util/archive.ts';
import { pdfPagesToLines } from './pdfText.ts';
import { parsePdfPages, isDetroit, type Designation, type StcProgram } from './parse.ts';
import { discoverPdfs, type PdfLink } from './fetch.ts';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const year = Number(opt('--year') ?? '2026');
const observed_at = new Date().toISOString();
const log = (m: string) => console.error(m);
const http = new HttpClient({ minIntervalMs: 2000, log });

const raws: ReturnType<typeof rawRef>[] = [];
const all: Designation[] = [];
const perPdf: { url: string; program: StcProgram; pages: number; certificates: number; detroit: number; source_updated: string | null }[] = [];
let status: 'ok' | 'blocked' | 'partial' = 'ok';
let note = '';
let newestSourceUpdated: string | null = null;

async function ingest(bytes: Uint8Array, link: PdfLink, lastModified: string | null) {
  const name = link.url.split('?')[0]!.split('/').pop()!;
  const r = writeRaw('mi-stc', name, bytes, { url: link.url, source_updated: lastModified ? new Date(lastModified).toISOString() : null, content_type: 'application/pdf', fetched_at: observed_at });
  raws.push(rawRef(r));
  if (r.meta.source_updated && (!newestSourceUpdated || r.meta.source_updated > newestSourceUpdated)) newestSourceUpdated = r.meta.source_updated;
  const pages = await pdfPagesToLines(bytes);
  const recs = parsePdfPages(pages, { pdf_url: link.url.split('?')[0]!, pdf_sha256: r.meta.sha256, observed_at });
  const det = recs.filter(isDetroit);
  perPdf.push({ url: link.url.split('?')[0]!, program: link.program, pages: pages.length, certificates: recs.length, detroit: det.length, source_updated: r.meta.source_updated });
  all.push(...recs);
}

const fromFile = opt('--from-file');
if (fromFile) {
  const bytes = new Uint8Array(readFileSync(fromFile));
  await ingest(bytes, { program: (opt('--program') ?? 'OPRA') as StcProgram, label: 'local', url: opt('--url') ?? `file://${fromFile}` }, null);
} else {
  try {
    const session = await openBrowser(http);
    try {
      const links = await discoverPdfs(session, year, log);
      for (const link of links) {
        const got = await session.fetchBytes(link.url);
        if (got.status !== 200 || !(got.contentType ?? '').includes('pdf')) { log(`skip ${link.url}: HTTP ${got.status} ${got.contentType}`); status = 'partial'; continue; }
        log(`fetched ${link.program} ${link.url.split('?')[0]!.split('/').pop()} (${got.bytes.length} bytes, Last-Modified ${got.lastModified})`);
        await ingest(got.bytes, link, got.lastModified);
      }
    } finally { await session.close(); }
  } catch (e) {
    if (e instanceof BotChallengeError || e instanceof RobotsDisallowedError) { status = 'blocked'; note = e.message; log(note); }
    else throw e;
  }
}

const detroit = all.filter(isDetroit).sort((a, b) => `${a.program}${a.certificate_no}`.localeCompare(`${b.program}${b.certificate_no}`));
const normalized_path = writeNdjson('mi-stc', detroit);
writeNdjson('mi-stc-statewide', all);
updateManifest({ source_id: 'mi-stc', fetched_at: observed_at, source_updated: newestSourceUpdated, records: detroit.length, normalized_path, raw: raws, status, note: note || `year ${year}; ${all.length} certificates statewide across ${perPdf.length} PDFs; ${detroit.length} in Detroit; statewide copy at data/normalized/mi-stc-statewide.ndjson` });
console.log(JSON.stringify({ source_id: 'mi-stc', status, year, pdfs: perPdf, statewide_certificates: all.length, detroit_certificates: detroit.length, by_program: Object.fromEntries((['OPRA', 'IFT', 'CRA'] as const).map((p) => [p, { statewide: all.filter((d) => d.program === p).length, detroit: detroit.filter((d) => d.program === p).length }])), examples: detroit.slice(0, 3) }, null, 2));
if (status === 'blocked') process.exit(2);
