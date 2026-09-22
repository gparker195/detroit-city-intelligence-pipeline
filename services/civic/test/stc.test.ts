import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePdfPages, parseCoverLetterPage, isDetroit, parseLongDate, STC_LIMITATIONS } from '../src/stc/parse.ts';
import { selectCertificateLinks } from '../src/stc/fetch.ts';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8')) as string[][];
const ctx = { pdf_url: 'https://www.michigan.gov/x.pdf', pdf_sha256: 'abc', observed_at: '2026-09-21T00:00:00Z' };

test('OPRA 8/18/26: certificate pages only, Detroit filter, fields', () => {
  const pages = fx('stc-opra-81826-lines.json');
  const recs = parsePdfPages(pages, ctx);
  // 5 pages: letter + certificate for 3-24-0029, then three letter-only approvals (no certificate page published).
  assert.equal(recs.length, 4);
  assert.deepEqual(recs.map((r) => r.record_basis), ['certificate', 'cover_letter', 'cover_letter', 'cover_letter']);
  assert.deepEqual(recs.map((r) => r.city), ['Detroit', 'Bay City', 'Grand Rapids', 'Muskegon']);
  const first = recs[0]!;
  assert.equal(first.program, 'OPRA'); assert.equal(first.certificate_no, '3-24-0029');
  assert.equal(first.applicant_entity, '16703 Warren BD LLC'); assert.equal(first.address, '16703 E. Warren');
  assert.equal(first.city, 'Detroit'); assert.equal(first.county, 'Wayne'); assert.equal(first.local_unit, 'City of Detroit');
  assert.equal(first.approved_date, '2026-08-18'); assert.equal(first.term_years, 12); assert.equal(first.begins, '2026-12-31'); assert.equal(first.ends, '2038-12-30');
  assert.equal(first.real_property_investment, 4768515); assert.equal(first.page, 2);
  assert.deepEqual(first.limitations, STC_LIMITATIONS);
  assert.ok(isDetroit(first));
  for (const r of recs) assert.ok(!/Dear|Hodge|Harrold|Cruz|Bourdon/.test(JSON.stringify(r)), 'no cover-letter person names');
});
test('IFT 6/9/26: owned-or-leased phrasing, non-Detroit rows excluded by filter', () => {
  const recs = parsePdfPages(fx('stc-ift-6-9-26-lines.json'), ctx);
  assert.ok(recs.length >= 2);
  const r = recs.find((x) => x.certificate_no === '2026-011')!;
  assert.equal(r.program, 'IFT'); assert.equal(r.applicant_entity, 'St. John Truck & Trailer Services, Inc');
  assert.equal(r.address, '5815 Grand Haven Road'); assert.equal(r.city, 'Norton Shores'); assert.equal(r.county, 'Muskegon'); assert.equal(r.approved_date, '2026-06-09');
  assert.equal(isDetroit(r), false);
  const twp = recs.find((x) => x.certificate_no === '2026-014');
  assert.ok(twp); assert.equal(twp.city, 'Van Buren'); assert.equal(twp.local_unit, 'Van Buren Charter Township'); assert.equal(twp.address, 'Ecorse Road & Denton Road');
  const det = recs.find((x) => x.applicant_entity === 'BD Venture Studio, LLC')!; assert.equal(det.city, 'Detroit'); assert.equal(det.address, '1530 Winder Street'); assert.ok(isDetroit(det)); assert.equal(det.begins, '2026-12-31'); assert.equal(det.ends, '2038-12-30');
});
test('cover-letter fallback: certificate number, entity, address, unit; addressee not stored', () => {
  const lines = ['June 9, 2026', 'William LaLonde', 'Let ’ s Try Everything, LLC', '1506 Borton Avenue', 'Essexville, MI 48732', 'Dear William LaLonde:', 'The State Tax Commission, at their June 9, 2026, meeting, considered and approved', 'your application for an obsolete property rehabilitation project, in accordance with Public', "Act 146 of 2000, as amended. Enclosed is certificate number 3-26-0012, issued to Let's", 'Try Everything, LLC for the project located at 103 N. Walnut Street, City of Bay City,', 'Bay County.'];
  const d = parseCoverLetterPage(lines, 2, ctx)!;
  assert.ok(d); assert.equal(d.record_basis, 'cover_letter'); assert.equal(d.program, 'OPRA'); assert.equal(d.certificate_no, '3-26-0012');
  assert.equal(d.applicant_entity, "Let's Try Everything, LLC"); assert.equal(d.address, '103 N. Walnut Street'); assert.equal(d.city, 'Bay City'); assert.equal(d.county, 'Bay'); assert.equal(d.approved_date, '2026-06-09');
  assert.ok(!JSON.stringify(d).includes('LaLonde'));
  // certificate pages win over letters for the same number
  const opra = parsePdfPages(fx('stc-opra-81826-lines.json'), ctx);
  assert.equal(opra.filter((r) => r.certificate_no === '3-24-0029').length, 1); assert.equal(opra[0]!.record_basis, 'certificate');
});
test('date helper', () => { assert.equal(parseLongDate('August 18, 2026'), '2026-08-18'); assert.equal(parseLongDate('nope'), null); });
test('link discovery keeps 2026 certificate lists, drops amendments/transfers/revocations and other years', () => {
  const links = [
    { label: 'Certificates', href: 'https://www.michigan.gov/taxes/-/media/.../Obsolete-Property-Rehabilitation-Act/2026/OPRA-New-Certificates-81826.pdf?rev=1' },
    { label: 'Amendments', href: 'https://www.michigan.gov/taxes/-/media/.../2026/OPRA-Amended-Certificate-6-9-26.pdf' },
    { label: 'Dismissal', href: 'https://www.michigan.gov/taxes/-/media/.../2026/OPRA-Dismissal-Certificate-81826.pdf' },
    { label: 'Certificates (5/11/26)', href: 'https://www.michigan.gov/taxes/-/media/.../OPRA/OPRA--New-Certificates-51126.pdf?rev=2' },
    { label: 'New Certificates', href: 'https://www.michigan.gov/taxes/-/media/.../2026/2-24-2026-IFT-Approved-Certificates.pdf' },
    { label: 'Certificates (8/26/14)', href: 'https://www.michigan.gov/taxes/-/media/.../2014/2014_82614_CRE_New_Certificates.pdf' },
    { label: 'Transfers', href: 'https://www.michigan.gov/taxes/-/media/.../2026/IFT-Transfer-4-7-26.pdf' },
  ];
  const picked = selectCertificateLinks(links, 'OPRA', 2026).map((l) => l.url.split('/').pop()!.split('?')[0]);
  assert.deepEqual(picked, ['OPRA-New-Certificates-81826.pdf', 'OPRA--New-Certificates-51126.pdf', '2-24-2026-IFT-Approved-Certificates.pdf']);
});
