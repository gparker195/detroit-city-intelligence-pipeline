/** Program Registry schema + validator (no dependencies). */
export const PROGRAM_KINDS = ['grant', 'loan', 'certification', 'registration', 'support'] as const;
export type ProgramKind = (typeof PROGRAM_KINDS)[number];
export const PROGRAM_LIMITATION = 'Eligibility is determined by the administrator; this app never states that a user qualifies.';

export interface Program {
  id: string;
  name: string;
  administrator: string;
  kind: ProgramKind;
  eligibility_summary_as_published: string;
  award_range: string | null;
  application_window: string;            // ISO dates "YYYY-MM-DD..YYYY-MM-DD", or "rolling" | "unknown"
  geography_rule: string;
  official_url: string;
  verified_on: string;                   // YYYY-MM-DD
  verification_note?: string;            // how it was read (page, press page, blocked-with-fallback)
  details?: Record<string, unknown>;     // e.g. certification types
  limitations: string[];
}
export interface ProgramRegistry { registry_version: string; authored_by: string; programs: Program[] }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const WINDOW = /^(rolling|unknown|\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}\.\.unknown|unknown\.\.\d{4}-\d{2}-\d{2})$/;

export function validateProgram(p: unknown, path = 'program'): string[] {
  const errs: string[] = [];
  if (!p || typeof p !== 'object') return [`${path}: not an object`];
  const o = p as Record<string, unknown>;
  const req = (k: string, t: 'string' | 'array' | 'string|null') => {
    const v = o[k];
    if (t === 'string' && (typeof v !== 'string' || !v.trim())) errs.push(`${path}.${k}: required non-empty string`);
    if (t === 'array' && !Array.isArray(v)) errs.push(`${path}.${k}: required array`);
    if (t === 'string|null' && !(v === null || (typeof v === 'string' && v.trim()))) errs.push(`${path}.${k}: string or null`);
  };
  for (const k of ['id', 'name', 'administrator', 'kind', 'eligibility_summary_as_published', 'application_window', 'geography_rule', 'official_url', 'verified_on']) req(k, 'string');
  req('award_range', 'string|null');
  req('limitations', 'array');
  if (typeof o['id'] === 'string' && !/^[a-z0-9-]+$/.test(o['id'])) errs.push(`${path}.id: kebab-case only`);
  if (typeof o['kind'] === 'string' && !(PROGRAM_KINDS as readonly string[]).includes(o['kind'])) errs.push(`${path}.kind: one of ${PROGRAM_KINDS.join('|')}`);
  if (typeof o['application_window'] === 'string' && !WINDOW.test(o['application_window'])) errs.push(`${path}.application_window: "YYYY-MM-DD..YYYY-MM-DD" | "rolling" | "unknown"`);
  if (typeof o['official_url'] === 'string' && !/^https:\/\//.test(o['official_url'])) errs.push(`${path}.official_url: https URL`);
  if (typeof o['verified_on'] === 'string' && !ISO_DATE.test(o['verified_on'])) errs.push(`${path}.verified_on: YYYY-MM-DD`);
  if (Array.isArray(o['limitations']) && !o['limitations'].includes(PROGRAM_LIMITATION)) errs.push(`${path}.limitations: must include the standard eligibility limitation`);
  return errs;
}

export function validateRegistry(r: unknown): string[] {
  if (!r || typeof r !== 'object') return ['registry: not an object'];
  const o = r as Record<string, unknown>;
  const errs: string[] = [];
  if (typeof o['registry_version'] !== 'string') errs.push('registry.registry_version: string');
  if (!Array.isArray(o['programs']) || o['programs'].length === 0) return [...errs, 'registry.programs: non-empty array'];
  const ids = new Set<string>();
  (o['programs'] as unknown[]).forEach((p, i) => {
    errs.push(...validateProgram(p, `programs[${i}]`));
    const id = (p as Record<string, unknown>)['id'];
    if (typeof id === 'string') { if (ids.has(id)) errs.push(`programs[${i}].id: duplicate ${id}`); ids.add(id); }
  });
  return errs;
}
