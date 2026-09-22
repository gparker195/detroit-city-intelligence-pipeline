/**
 * State Tax Commission certificate PDFs -> Designation-like records.
 * Each PDF is a stack of (cover letter, certificate) pairs. Only certificate pages are parsed:
 * they carry the entity, the property address, the local unit, the county, and the issue date.
 * Cover letters name an individual contact and are deliberately not parsed (place, not person).
 */
export type StcProgram = 'OPRA' | 'IFT' | 'CRA';
export interface Designation {
  program: StcProgram;
  certificate_no: string;
  applicant_entity: string | null;
  address: string | null;
  local_unit: string | null;
  city: string | null;
  county: string | null;
  approved_date: string | null;          // ISO date
  approved_date_as_published: string | null;
  term_years: number | null;
  begins: string | null;
  ends: string | null;
  real_property_investment: number | null;
  page: number;
  /** 'certificate' = parsed from the certificate form; 'cover_letter' = only the approval letter was published (no certificate page). */
  record_basis: 'certificate' | 'cover_letter';
  pdf_url: string;
  pdf_sha256: string;
  source_id: 'mi-stc';
  observed_at: string;
  limitations: string[];
}
export const STC_LIMITATIONS = ['A certificate records a State Tax Commission action as published; verify with the Assessor.'];

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export function parseLongDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1]!.toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}
function money(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function detectProgram(pageText: string): StcProgram | null {
  if (/Obsolete Property Rehabilitation Exemption\s+Certificate|Obsolete Property Rehabilitation Exemption Certificate/i.test(pageText)) return 'OPRA';
  if (/Industrial Facilities Exemption\s+Certificate/i.test(pageText)) return 'IFT';
  if (/Commercial Rehabilitation Exemption\s+Certificate/i.test(pageText)) return 'CRA';
  return null;
}

export function parseCertificatePage(lines: string[], page: number, ctx: { pdf_url: string; pdf_sha256: string; observed_at: string }): Designation | null {
  // Join lines; repair years the PDF text layer splits ("202 2", "20 34") before matching dates.
  const text = lines.join(' ').replace(/\b(20\d)\s(\d)\b/g, '$1$2').replace(/\b(20)\s(\d{2})\b/g, '$1$2');
  const certNo = text.match(/Certificate (?:No\.?|Number)\s*([A-Za-z0-9][A-Za-z0-9-]*)/i);
  if (!certNo) return null;
  const program = detectProgram(text);
  if (!program) return null;
  // "... owned [or leased] by <entity>, and located at <address>, <local unit>, County of <county>, Michigan"
  // where <local unit> is "City of X" | "Village of X" | "Township of X" | "X Township" | "X Charter Township".
  const owned = text.match(/owned (?:or leased )?by\s+(.+?),\s+and located at\s+(.+),\s+([^,]+?),\s+County of\s+([^,]+?),/i);
  const unit = text.match(/,\s+([^,]+?),\s+County of\s+([^,]+?),\s+Michigan/i);
  const issued = text.match(/issued on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
  const term = text.match(/period of\s+(\d+)\s+year/i);
  const span = text.match(/Beginning\s+([A-Za-z]+\s+\d{1,2},\s+\d{4}),?\s+and ending\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
  const inv = text.match(/real property investment amount[^$]*(\$[\d,]+)/i) ?? text.match(/Real Property:\s*(\$\s?[\d,]+)/i);
  const unitAsPublished = (owned?.[3] ?? unit?.[1] ?? '').trim() || null;
  const unitName = unitAsPublished ? unitAsPublished.replace(/^(City|Village|Township|Charter Township) of\s+/i, '').replace(/\s+(Charter Township|Township)$/i, '').trim() : null;
  return {
    program,
    certificate_no: certNo[1]!,
    applicant_entity: owned?.[1]?.trim() ?? null,
    address: owned?.[2]?.trim() ?? null,
    local_unit: unitAsPublished,
    city: unitName,
    county: (owned?.[4] ?? unit?.[2] ?? '').trim() || null,
    approved_date: parseLongDate(issued?.[1]),
    approved_date_as_published: issued?.[1] ?? null,
    term_years: term ? Number(term[1]) : null,
    begins: parseLongDate(span?.[1]),
    ends: parseLongDate(span?.[2]),
    real_property_investment: money(inv?.[1]),
    page,
    record_basis: 'certificate',
    pdf_url: ctx.pdf_url,
    pdf_sha256: ctx.pdf_sha256,
    source_id: 'mi-stc',
    observed_at: ctx.observed_at,
    limitations: [...STC_LIMITATIONS],
  };
}

/**
 * Fallback for PDFs that publish only the approval letter (seen: OPRA 6/9/26). The letter names the
 * certificate number, the entity, the project address and the local unit; the addressee (a person)
 * is not read. Used only when no certificate page carries that certificate number.
 */
export function parseCoverLetterPage(lines: string[], page: number, ctx: { pdf_url: string; pdf_sha256: string; observed_at: string }): Designation | null {
  const text = lines.join(' ').replace(/\b(20\d)\s(\d)\b/g, '$1$2').replace(/\s+’\s+/g, '’');
  const m = text.match(/certificate number\s+([A-Za-z0-9][A-Za-z0-9-]*),?\s+issued to\s+(.+?)\s+for the project located at\s+(.+?),\s+(?:the\s+)?(City of\s+[^,]+|Village of\s+[^,]+|Township of\s+[^,]+|[^,]+? Charter Township|[^,]+? Township|[^,]+?),\s+([^,]+?) County/i);
  if (!m) return null;
  const program: StcProgram | null = /obsolete property rehabilitation/i.test(text) ? 'OPRA' : /industrial facilit/i.test(text) ? 'IFT' : /commercial rehabilitation/i.test(text) ? 'CRA' : null;
  if (!program) return null;
  const meeting = text.match(/at their\s+([A-Za-z]+\s+\d{1,2},\s+\d{4}),?\s+meeting/i) ?? text.match(/issued at the\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})\s+meeting/i);
  const unitAsPublished = m[4]!.trim();
  const unitName = unitAsPublished.replace(/^(City|Village|Township|Charter Township) of\s+/i, '').replace(/\s+(Charter Township|Township)$/i, '').trim();
  return {
    program, certificate_no: m[1]!, applicant_entity: m[2]!.trim(), address: m[3]!.trim(),
    local_unit: /^(City|Village|Township) of|Township$/i.test(unitAsPublished) ? unitAsPublished : `City of ${unitName}`,
    city: unitName, county: m[5]!.trim(),
    approved_date: parseLongDate(meeting?.[1]), approved_date_as_published: meeting?.[1] ?? null,
    term_years: null, begins: null, ends: null, real_property_investment: null,
    page, record_basis: 'cover_letter', pdf_url: ctx.pdf_url, pdf_sha256: ctx.pdf_sha256, source_id: 'mi-stc', observed_at: ctx.observed_at, limitations: [...STC_LIMITATIONS],
  };
}

export function parsePdfPages(pages: string[][], ctx: { pdf_url: string; pdf_sha256: string; observed_at: string }): Designation[] {
  const out: Designation[] = [];
  pages.forEach((lines, i) => { const d = parseCertificatePage(lines, i + 1, ctx); if (d) out.push(d); });
  const seen = new Set(out.map((d) => d.certificate_no));
  pages.forEach((lines, i) => { const d = parseCoverLetterPage(lines, i + 1, ctx); if (d && !seen.has(d.certificate_no)) { seen.add(d.certificate_no); out.push(d); } });
  return out;
}

export function isDetroit(d: Designation): boolean {
  return !!d.city && /^detroit$/i.test(d.city.trim());
}
