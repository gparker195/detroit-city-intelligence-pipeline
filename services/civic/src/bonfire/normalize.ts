/**
 * Bonfire public "Open Public Opportunities" table -> Solicitation records.
 * The normalizer takes already-extracted row cells so it can be tested against a fixture
 * whether the rows came from a JSON endpoint or the rendered DOM.
 */
export interface BonfireRow {
  ref: string;
  title: string;
  department: string;
  close_at: string;   // as displayed, e.g. "Sep 30, 2026 3:00 PM EDT"
  days_left: string;  // as displayed, e.g. "9 days"
  url: string;
}
export type SolicitationType = 'RFP' | 'RFQ' | 'RFI' | 'bid' | 'sole-source' | 'unknown';
export interface Solicitation {
  ref: string;
  title: string;
  department: string;
  close_at: string | null;
  close_at_as_published: string;
  days_left: number | null;
  url: string;
  type_guess: SolicitationType;
  source_id: 'bonfire';
  observed_at: string;
  limitations: string[];
}
export const SOLICITATION_LIMITATIONS = ['An open solicitation is not an award.'];

export function guessType(ref: string, title: string): SolicitationType {
  const s = `${ref} ${title}`;
  if (/\bRFP\b|request for proposal/i.test(s)) return 'RFP';
  if (/\bRFQ\b|request for quot/i.test(s)) return 'RFQ';
  if (/\bRFI\b|request for information/i.test(s)) return 'RFI';
  if (/sole[- ]source/i.test(s)) return 'sole-source';
  if (/\bIFB\b|\bITB\b|\bbid\b|invitation (to|for) bid/i.test(s)) return 'bid';
  return 'unknown';
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** "Sep 30, 2026 3:00 PM EDT" -> ISO with the stated offset. Returns null when unparseable. */
export function parseBonfireDate(s: string): string | null {
  const m = s.trim().match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([AP]M))?\s*([A-Z]{3,4})?$/i);
  if (!m) return null;
  const mon = MONTHS[m[1]!.toLowerCase()];
  if (mon === undefined) return null;
  let h = m[4] ? Number(m[4]) : 0; const min = m[5] ? Number(m[5]) : 0;
  if (m[6]) { const pm = m[6].toUpperCase() === 'PM'; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  const tz = (m[7] ?? 'EDT').toUpperCase();
  const offset = tz === 'EST' ? '-05:00' : tz === 'EDT' ? '-04:00' : tz === 'UTC' ? 'Z' : '-04:00';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${m[3]}-${pad(mon + 1)}-${pad(Number(m[2]))}T${pad(h)}:${pad(min)}:00${offset}`;
}

export function normalizeRow(row: BonfireRow, observed_at: string): Solicitation {
  const days = row.days_left.match(/-?\d+/);
  return {
    ref: row.ref.trim(),
    title: row.title.trim(),
    department: row.department.trim(),
    close_at: parseBonfireDate(row.close_at),
    close_at_as_published: row.close_at.trim(),
    days_left: days ? Number(days[0]) : null,
    url: row.url,
    type_guess: guessType(row.ref, row.title),
    source_id: 'bonfire',
    observed_at,
    limitations: [...SOLICITATION_LIMITATIONS],
  };
}
