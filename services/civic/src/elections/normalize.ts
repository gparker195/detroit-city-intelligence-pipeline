/**
 * Elections knowledge pack: rule records (authored, dated, cited) + site records parsed from the
 * Department of Elections voter site (detroitvotes.org/early/), which lists every early vote
 * center and drop box with its address and a per-election open/closed flag.
 */
export const ELECTION_LIMITATIONS = ['Rules as published by the Department of Elections; confirm on the official page before acting.'];

export interface ElectionRule {
  record_type: 'rule';
  election_date: string;
  rule_key: string;
  value_as_published: string;
  official_url: string;
  corroborating_url?: string;
  verified_on: string;
  source_id: 'elections';
  observed_at: string;
  limitations: string[];
}
export interface ElectionSite {
  record_type: 'site';
  election_date: string;
  site_id: string;
  name: string;
  address_as_published: string;
  roles: ('early_vote_center' | 'drop_box' | 'register_to_vote')[];
  status_as_published: string | null;
  hours_as_published: string | null;
  lon: number | null;
  lat: number | null;
  geocode_note: string;
  official_url: string;
  verified_on: string;
  source_id: 'elections';
  observed_at: string;
  limitations: string[];
}
export interface ElectionLink {
  record_type: 'link_out';
  election_date: string | null;
  link_key: string;
  title: string;
  url: string;
  status_as_published: string | null;
  verified_on: string;
  source_id: 'elections';
  observed_at: string;
  limitations: string[];
}
export type ElectionRecord = ElectionRule | ElectionSite | ElectionLink;

export interface Pack {
  pack_version: string; election_date: string; election_name: string; verified_on: string;
  rules: { rule_key: string; value_as_published: string; official_url: string; corroborating_url?: string }[];
  link_outs: { link_key: string; title: string; url: string; election_date: string | null; status_as_published: string | null }[];
}

export function packToRecords(pack: Pack, observed_at: string): ElectionRecord[] {
  const rules: ElectionRule[] = pack.rules.map((r) => ({ record_type: 'rule', election_date: pack.election_date, rule_key: r.rule_key, value_as_published: r.value_as_published, official_url: r.official_url, ...(r.corroborating_url ? { corroborating_url: r.corroborating_url } : {}), verified_on: pack.verified_on, source_id: 'elections', observed_at, limitations: [...ELECTION_LIMITATIONS] }));
  const links: ElectionLink[] = pack.link_outs.map((l) => ({ record_type: 'link_out', election_date: l.election_date, link_key: l.link_key, title: l.title, url: l.url, status_as_published: l.status_as_published, verified_on: pack.verified_on, source_id: 'elections', observed_at, limitations: [...ELECTION_LIMITATIONS] }));
  return [...rules, ...links];
}

/** Strip tags from the /early/ page and return text lines. Kept dependency-free. */
export function htmlToLines(html: string): string[] {
  const t = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, '’').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return t.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const ADDRESS = /^\d{1,6} .+?(?:,? ?Detroit,? ?(?:MI|Michigan)?[ ,]*\d{5})?(?:, USA)?$/i;

/** Parse the site list: name, status line, address, then role tags until "Get more info". */
export function parseSites(html: string, ctx: { election_date: string; verified_on: string; observed_at: string; official_url: string }): ElectionSite[] {
  const lines = htmlToLines(html);
  const start = lines.findIndex((l) => /Find your nearest voting location/i.test(l));
  const end = lines.findIndex((l, i) => i > start && /Contact the Detroit City Clerk/i.test(l));
  const body = lines.slice(start >= 0 ? start + 1 : 0, end > 0 ? end : undefined);
  const sites: ElectionSite[] = [];
  let i = 0;
  while (i < body.length) {
    const name = body[i]!;
    if (/^(Find|Show:|Early Vote Centers & Drop Boxes|Drop Boxes Only)$/i.test(name)) { i++; continue; }
    const block: string[] = [];
    let j = i + 1;
    while (j < body.length && !/^Get more info$/i.test(body[j]!)) block.push(body[j++]!);
    if (j >= body.length) break;
    const status = block.find((l) => /closed for this election|open for this election|hours/i.test(l)) ?? null;
    const address = block.find((l) => ADDRESS.test(l)) ?? null;
    const roles: ElectionSite['roles'] = [];
    if (block.some((l) => /^Vote Early$/i.test(l))) roles.push('early_vote_center');
    if (block.some((l) => /^Drop Box$/i.test(l))) roles.push('drop_box');
    if (block.some((l) => /^Register to Vote$/i.test(l))) roles.push('register_to_vote');
    if (address && roles.length) {
      const hours = block.find((l) => /\d\s?(a\.?m\.?|p\.?m\.?)/i.test(l) && !/closed for this election/i.test(l)) ?? null;
      sites.push({ record_type: 'site', election_date: ctx.election_date, site_id: `site:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`, name: name.replace(/\s+$/, ''), address_as_published: address, roles, status_as_published: status, hours_as_published: hours, lon: null, lat: null, geocode_note: 'address only; not geocoded (match against the City address point layer in city-api)', official_url: ctx.official_url, verified_on: ctx.verified_on, source_id: 'elections', observed_at: ctx.observed_at, limitations: [...ELECTION_LIMITATIONS] });
    }
    i = j + 1;
  }
  return sites;
}

/** Cadence helper: daily within 45 days before the election, weekly otherwise. */
export function cadenceFor(election_date: string, today: Date): 'daily' | 'weekly' {
  const e = new Date(`${election_date}T00:00:00Z`).getTime();
  const d = (e - today.getTime()) / 86400000;
  return d >= 0 && d <= 45 ? 'daily' : 'weekly';
}
