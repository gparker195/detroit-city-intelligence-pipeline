/**
 * Typed registry of City of Detroit ArcGIS feeds ingested by this service.
 *
 * Service paths are never guessed at fetch time: `resolveServiceUrl` reads the ArcGIS item
 * (https://www.arcgis.com/sharing/rest/content/items/<id>?f=json) and uses its `url`.
 * `expected_service` records what the item resolved to on `terms_verified_on`; a mismatch
 * at runtime is logged (the resolved value wins) so a silently moved feed is visible.
 *
 * Governance (PRD "Field mappings", AGENTS.md "Place, not person"): every source carries a
 * field allowlist. The default policy drops person-level fields; taxpayer_1 / taxpayer_2 are
 * allowed because they are the owner of record as published on the parcel.
 */

import type { LayerField } from '../arcgis/featureServiceClient.ts';
import type { HttpClient } from '../util/http.ts';
import { buildUrl } from '../util/http.ts';

export const ARCGIS_ORG_ROOT = 'https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/';
export const ARCGIS_ITEM_ROOT = 'https://www.arcgis.com/sharing/rest/content/items/';

export const CITY_OPEN_DATA_DISCLAIMER =
  'Provided AS-IS by the City of Detroit Open Data Portal; no warranty as to accuracy, timeliness, or completeness.';

export const ZONING_MAP_DISCLAIMER =
  'Disclaimer: This zoning map is provided as a tool but contains inconsistencies and its accuracy should not be relied on. Please verify all information with the official zoning maps which can be found in PDF format here: https://detroitmi.gov/departments/buildings-safety-engineering-and-environmental-department/zoning-permit-infomation/zoning-map-index The City of Detroit assumes no liability or responsibility for any error or omissions in the information.';

export type Cadence = 'hourly' | 'daily' | 'weekly' | 'monthly';

export const CADENCE_HOURS: Record<Cadence, number> = { hourly: 1, daily: 24, weekly: 24 * 7, monthly: 24 * 30 };

export type Lifecycle = 'active' | 'deprecated' | 'successor' | 'retired';

/**
 * How `fetch:study-area` scopes a source:
 *   polygon   polygon/line layer; rows intersecting the study-area polygon (server-side, POST)
 *   buffer    point feed; rows within the study-area polygon plus a buffer (attribute bbox on
 *             longitude/latitude when the layer has them, else server polygon+distance; then an
 *             exact point-in-buffer test before the snapshot is written)
 *   citywide  small citywide table or layer (districts, precincts, SNF, registers); fetched whole
 */
export type FetchScope = 'polygon' | 'buffer' | 'citywide';

export interface FieldAllowlist {
  /** Fields whose name starts with any of these prefixes are excluded. */
  exclude_prefixes: string[];
  /** Fields with exactly these names are excluded. */
  exclude_fields: string[];
  /** Fields that are always kept, even if a prefix rule would drop them. */
  always_allow: string[];
}

export interface SourceDefinition {
  id: string;
  title: string;
  item_id: string;
  /** Service name the item resolved to on terms_verified_on. Not used to build URLs. */
  expected_service: string;
  layer: number;
  cadence: Cadence;
  attribution: string;
  disclaimer_text: string | null;
  /** Verbatim AS-IS reference carried by every City open-data source. */
  open_data_disclaimer: string;
  lifecycle: Lifecycle;
  terms_verified_on: string;
  /** Candidate stable keys, in order of preference; first present in the layer wins. */
  stable_key: string[];
  field_allowlist: FieldAllowlist;
  scope: FetchScope;
  /** When set, only these fields are kept (after the exclusion policy). Used for wide layers. */
  keep_only?: string[];
  notes?: string;
}

export const DEFAULT_FIELD_ALLOWLIST: FieldAllowlist = {
  exclude_prefixes: ['property_owner_', 'inspector_'],
  exclude_fields: ['owner_name', 'taxpayer_address', 'taxpayer_city', 'taxpayer_state', 'taxpayer_zip_code'],
  always_allow: ['taxpayer_1', 'taxpayer_2'],
};

function allowlist(extra: Partial<FieldAllowlist> = {}): FieldAllowlist {
  return {
    exclude_prefixes: [...new Set([...DEFAULT_FIELD_ALLOWLIST.exclude_prefixes, ...(extra.exclude_prefixes ?? [])])],
    exclude_fields: [...new Set([...DEFAULT_FIELD_ALLOWLIST.exclude_fields, ...(extra.exclude_fields ?? [])])],
    always_allow: [...new Set([...DEFAULT_FIELD_ALLOWLIST.always_allow, ...(extra.always_allow ?? [])])],
  };
}

const CITY = 'City of Detroit Open Data Portal';
const VERIFIED = '2026-09-21';

function city(
  def: Omit<SourceDefinition, 'attribution' | 'open_data_disclaimer' | 'lifecycle' | 'terms_verified_on' | 'disclaimer_text' | 'field_allowlist' | 'layer' | 'cadence' | 'scope'> &
    Partial<Pick<SourceDefinition, 'attribution' | 'disclaimer_text' | 'layer' | 'cadence' | 'scope'>> & { allowlist?: Partial<FieldAllowlist> },
): SourceDefinition {
  const { allowlist: extra, ...rest } = def;
  return {
    layer: 0,
    cadence: 'daily',
    attribution: CITY,
    disclaimer_text: null,
    scope: 'buffer',
    ...rest,
    open_data_disclaimer: CITY_OPEN_DATA_DISCLAIMER,
    lifecycle: 'active',
    terms_verified_on: VERIFIED,
    field_allowlist: allowlist(extra),
  };
}

/** Generic key fallbacks appended to every source's stable_key list. */
const GENERIC_KEYS = ['record_id', 'OBJECTID', 'ObjectId'];

export const SOURCES: readonly SourceDefinition[] = [
  city({
    id: 'building-permits',
    title: 'Building Permits',
    item_id: '86d47e86062e4beeb19344eb125b75d2',
    expected_service: 'bseed_building_permits',
    stable_key: ['record_id', ...GENERIC_KEYS],
    scope: 'buffer',
  }),
  city({
    id: 'dlba-for-sale',
    title: 'DLBA Properties For Sale',
    item_id: 'e0c4f46a09b9405cb18837e66e85c622',
    expected_service: 'DLBA_For_Sale',
    attribution: 'Detroit Land Bank Authority via City of Detroit Open Data Portal',
    stable_key: ['parcel_id', ...GENERIC_KEYS],
    notes: 'Small and volatile; no record_id, so parcel_id is the stable key.',
  }),
  city({
    id: 'zoning',
    title: 'Zoning',
    item_id: '99527307190240aa98bba80116273fb0',
    expected_service: 'Zoning_1',
    disclaimer_text: ZONING_MAP_DISCLAIMER,
    stable_key: ['FID', ...GENERIC_KEYS],
    scope: 'polygon',
  }),
  city({
    id: 'zoning-changes',
    title: 'Zoning Changes',
    item_id: 'fe255d873d9449d19cb9190c6e570c6f',
    expected_service: 'Zoning_Changes',
    stable_key: ['FID', ...GENERIC_KEYS],
    scope: 'polygon',
    notes: 'All zoning amendments based on Detroit Legal News (City description). Rows become rezoning changes on the timeline.',
  }),
  city({
    id: 'snf',
    title: 'Strategic Neighborhood Fund (SNF) areas',
    item_id: 'dafad9fc0e854d9fb03d9cb00ea5e69c',
    expected_service: 'SNF',
    stable_key: ['OBJECTID_1', ...GENERIC_KEYS],
    scope: 'citywide',
    notes: 'Eleven areas; Proj_NAME "Livernois / McNichols" is the v0 study-area polygon.',
  }),
  city({
    id: 'parcels-current',
    title: 'Parcels (Current)',
    item_id: '3c784c118e5c4083b37038e9b38573df',
    expected_service: 'parcel_file_current',
    stable_key: ['parcel_id', ...GENERIC_KEYS],
    scope: 'polygon',
    notes: 'Spine layer (about 378k polygons); always fetch with an envelope or polygon in development.',
  }),
  city({
    id: 'business-licenses',
    title: 'Business Licenses (Current)',
    item_id: '2addfbf566464896b4aa032ac873549b',
    expected_service: 'bseed_active_business_licenses',
    stable_key: ['record_id', ...GENERIC_KEYS],
  }),
  city({
    id: 'liquor-licenses',
    title: 'Liquor Licenses',
    item_id: '990a559e64754eb4a2e3cf34fce6516f',
    expected_service: 'Liquor_Licenses',
    attribution: 'Michigan Liquor Control Commission / LARA via City of Detroit',
    stable_key: ['ObjectId'],
    allowlist: { exclude_fields: ['account_name'] },
    notes: 'Verified 2026-09-22: `number` (license number) and `business_id` are null on every row of the live feed, so ObjectId is the only stable key; diffs will show churn if the City reloads the layer. account_name (licensee, may be a person) is not ingested; dba is.',
  }),
  city({
    id: 'blight-tickets',
    title: 'Blight Tickets',
    item_id: '9ce72b42872844bdbe272c607224e3b3',
    expected_service: 'blight_tickets',
    stable_key: ['ticket_id', ...GENERIC_KEYS],
    // Explicit, not just the default: this feed publishes owner and inspector names.
    allowlist: { exclude_prefixes: ['property_owner_', 'inspector_'], exclude_fields: ['inspector_name'] },
    notes: 'Tickets are shown on the parcel; owner and inspector fields are never ingested.',
  }),
  city({
    id: 'vacant-property-registrations',
    title: 'Vacant Property Registrations',
    item_id: '85fccf67f3e44c4bb767b9e2b190d576',
    expected_service: 'bseed_vacant_property_registrations',
    stable_key: ['record_id', ...GENERIC_KEYS],
    allowlist: { exclude_fields: ['owner_name'] },
  }),
  city({
    id: 'certificate-of-occupancy',
    title: 'Certificate of Occupancy',
    item_id: '0b5291df3d1c4b3693af5d4ca508030b',
    expected_service: 'bseed_occupancy_certificates',
    stable_key: ['record_id', ...GENERIC_KEYS],
  }),
  city({
    id: 'dev-opportunities-city-land',
    title: 'Development Opportunities: City Real Estate Land',
    item_id: 'e5311d226c004c1a9d440123c9d15648',
    expected_service: 'development_opportunities_city_real_estate_land',
    stable_key: ['parcel_id', ...GENERIC_KEYS],
    scope: 'polygon',
  }),
  city({
    id: 'election-precincts-2024',
    title: 'Detroit Election Precincts 2024',
    item_id: '5d861ef3ba5a43e88dad58062b99f571',
    expected_service: 'election_precincts_2024',
    cadence: 'weekly',
    stable_key: ['election_precinct', ...GENERIC_KEYS],
    scope: 'citywide',
    notes: 'PRD: weekly, daily in the 45 days before an election (not yet automated).',
  }),

  // ---- Milestone 1 additions (items verified live 2026-09-22) ----
  city({
    id: 'building-footprints',
    title: 'Detroit Building Footprints (Public Safety)',
    item_id: '00514a20422a4d089af8bb72129992cc',
    expected_service: 'Detroit_Building_Footprints_(Public_Safety)',
    stable_key: ['bldgID', 'FID', ...GENERIC_KEYS],
    scope: 'polygon',
    keep_only: ['FID', 'bldgID', 'parcelID', 'addressID', 'MEDIAN_HGT', 'STORIES', 'YEAR_BUILT', 'YEAR_DEMO', 'bldgType', 'CONDITION', 'RES_SQFT', 'NONRES_SQF', 'HOUSING_UN'],
    notes: '380,076 polygons, layer last edited 2023-07; 2023 vintage shown as such.',
  }),
  city({
    id: 'restaurant-inspections',
    title: 'Restaurant Inspections (establishments)',
    item_id: 'ffd4ed9aa12a4df5ad13d81175da4e49',
    expected_service: 'food_service_establishment_inspections',
    stable_key: ['establishment_id', ...GENERIC_KEYS],
    allowlist: { exclude_fields: ['establishment_owner'] },
    notes: 'Successor of the deprecated Restaurant Establishments dataset. Owner field is not ingested (place, not person).',
  }),
  city({
    id: 'dlba-owned',
    title: 'DLBA Owned Properties',
    item_id: '848bc665295f4ca9b1e25068ffa88ab0',
    expected_service: 'DLBA_Owned_Properties',
    attribution: 'Detroit Land Bank Authority via City of Detroit Open Data Portal',
    stable_key: ['parcel_id', ...GENERIC_KEYS],
    notes: 'inventory_status_socrata is an inventory status, never availability by itself.',
  }),
  city({
    id: 'dev-opportunities-city-buildings',
    title: 'Development Opportunities: City Real Estate Buildings',
    item_id: 'ff6046d9fab942af9209f1e29bfe596b',
    expected_service: 'development_opportunities_city_real_estate_buildings',
    stable_key: ['parcel_id', ...GENERIC_KEYS],
    scope: 'polygon',
  }),
  city({
    id: 'dev-opportunities-dlba-buildings',
    title: 'Development Opportunities: DLBA Buildings',
    item_id: 'e040ffa2750143a6a20c44a9a040356a',
    expected_service: 'development_opportunities_dlba_buildings',
    attribution: 'Detroit Land Bank Authority via City of Detroit Open Data Portal',
    stable_key: ['parcel_id', ...GENERIC_KEYS],
    scope: 'polygon',
  }),
  city({
    id: 'master-plan-flu',
    title: 'Current Master Plan Future General Land Use',
    item_id: '9cc8ca40556f47dbb2e754c76fae2821',
    expected_service: 'MasterPlan1',
    stable_key: ['OBJECTID', ...GENERIC_KEYS],
    scope: 'polygon',
  }),
  city({
    id: 'nez-nr',
    title: 'Neighborhood Enterprise Zones: New / Rehab (NR)',
    item_id: 'ad175db7d7b640518a1b530c3f5aaa36',
    expected_service: 'assessor_nez_new_rehab_districts',
    stable_key: ['object_id', ...GENERIC_KEYS],
    scope: 'citywide',
    allowlist: { exclude_fields: ['petitioner_developer'] },
    notes: 'Designation context only. Petitioner name not ingested.',
  }),
  city({
    id: 'hrd-districts',
    title: 'HRD Districts',
    item_id: 'b5fd38d4002c47379e63f8f3b926e4aa',
    expected_service: 'HRD_Districts',
    stable_key: ['OBJECTID', ...GENERIC_KEYS],
    scope: 'citywide',
    cadence: 'weekly',
  }),
  city({
    id: 'nrsa-2020',
    title: '2020 Neighborhood Revitalization Strategy Areas (NRSA)',
    item_id: 'e482a4a14ac9480b88605e71f6291027',
    expected_service: 'NRSA_2020',
    stable_key: ['OBJECTID', ...GENERIC_KEYS],
    scope: 'citywide',
    cadence: 'weekly',
  }),
  city({
    id: 'gateway-radials',
    title: 'Gateway Radial Thoroughfares',
    item_id: '0f16dfe1e7dd45fd85f903f9e419881f',
    expected_service: 'gateway_radial_thoroughfares',
    stable_key: ['thoroughfare_id', ...GENERIC_KEYS],
    scope: 'citywide',
    cadence: 'weekly',
    notes: 'Polylines; a parcel is "on the corridor" only within a stated distance of the centreline.',
  }),
  city({
    id: 'council-districts-2026',
    title: 'Detroit City Council Districts 2026',
    item_id: '521074a90fb04afe9d3adde897e6b010',
    expected_service: 'city_council_districts_2026',
    stable_key: ['council_district_id', ...GENERIC_KEYS],
    scope: 'citywide',
    cadence: 'weekly',
  }),
  city({
    id: 'council-crosswalk',
    title: '2026 to 2013 Council District Crosswalk for Addresses',
    item_id: '037ec842c37846b0861beba1d1e0a9a7',
    expected_service: 'address_council_district_2013_crosswalk',
    stable_key: ['address_id', ...GENERIC_KEYS],
    cadence: 'weekly',
    notes: 'Only addresses whose district changed on 2026-01-01.',
  }),
  city({
    id: 'ocp-agreements',
    title: 'OCP Procurement Agreements',
    item_id: '1d58bb7735bd4ab9b5dc07be2bfe7027',
    expected_service: 'OCP_Procurement_Contracts',
    stable_key: ['number', ...GENERIC_KEYS],
    scope: 'citywide',
    notes: 'Table without geometry; joined by address_id where the agreement carries one.',
  }),
  city({
    id: 'business-certification-register',
    title: 'Detroit Business Certification Register',
    item_id: '9f6b399045dd4f5991835a65a1b20b7f',
    expected_service: 'Detroit_Business_Certification_Register',
    stable_key: ['OBJECTID', ...GENERIC_KEYS],
    scope: 'citywide',
    allowlist: { exclude_prefixes: ['authorized_contact_'], exclude_fields: ['authorized_contact_first_name', 'authorized_contact_last_name', 'business_phone_number'] },
    notes: 'Certified businesses (public register). Contact names and phone numbers are never ingested.',
  }),
  city({
    id: 'property-sales',
    title: 'Property Sales (Assessor)',
    item_id: 'd26fda1e80b04630a6e56627e6fbceb8',
    expected_service: 'assessor_property_sales_view',
    stable_key: ['sale_id', ...GENERIC_KEYS],
    allowlist: { exclude_fields: ['grantor', 'grantee'] },
    notes: 'History, never availability. Grantor/grantee names are not ingested; owner of record comes from Parcels only.',
  }),
  city({
    id: 'improve-detroit-311',
    title: 'Improve Detroit Issues (311)',
    item_id: '9f6987d3fd1b4b7a9d1689ab86ef29e8',
    expected_service: 'improve_detroit',
    stable_key: ['issue_id', ...GENERIC_KEYS],
    keep_only: ['issue_id', 'request_type', 'status', 'priority_code', 'report_method', 'created_at', 'acknowledged_at', 'updated_at', 'closed_at', 'reopened_at', 'num_days_to_close', 'num_hours_to_close', 'address', 'neighborhood', 'council_district', 'zip_code', 'street_number', 'street_prefix', 'street_name', 'street_type', 'address_id', 'longitude', 'latitude', 'ObjectId'],
    notes: 'Category, type, status, dates and location only; aggregated by place and time, never by requester. issue_url is not kept.',
  }),
  city({
    id: 'rental-registrations',
    title: 'Rental Registrations',
    item_id: '145ebb0e507f4aae95f028559a2f0877',
    expected_service: 'bseed_rental_registrations',
    stable_key: ['record_id', ...GENERIC_KEYS],
    allowlist: { exclude_prefixes: ['owner_'], exclude_fields: ['owner_name'] },
  }),
  city({
    id: 'certificates-of-compliance-residential',
    title: 'Active Residential Certificates of Compliance',
    item_id: 'e363e21ea5eb4ef5a838f5098b7f60a0',
    expected_service: 'bseed_active_residential_compliance_certificates',
    stable_key: ['record_id', ...GENERIC_KEYS],
  }),
  city({
    id: 'certificates-of-compliance-commercial',
    title: 'Active Commercial Certificates of Compliance',
    item_id: '3b86d3a64db640e5b14e9c3f889d3def',
    expected_service: 'bseed_active_commercial_compliance_certificates',
    stable_key: ['record_id', ...GENERIC_KEYS],
  }),
  city({
    id: 'fire-incidents',
    title: 'Fire Incidents',
    item_id: 'd157b0f3decd4c8ea1b0e12c82657552',
    expected_service: 'Fire_Incidents',
    stable_key: ['incident_exposure_id', ...GENERIC_KEYS],
    notes: 'Aggregated by place and time; never a personal-safety tool.',
  }),
  city({
    id: 'row-permits',
    title: 'Detroit Right of Way Permits (points)',
    item_id: '2b6d7fc01ebd4ba3a63e6792ce63df4b',
    expected_service: 'detroit_right_of_way_permits',
    layer: 5,
    stable_key: ['permit_segment_id', ...GENERIC_KEYS],
    notes: 'Service has layers 4 (lines, empty), 5 (points) and table 3 (records); the points layer is ingested.',
  }),
  city({
    id: 'streetscape-projects',
    title: 'Streetscape Projects',
    item_id: '4e1cd10f154f4b15bc345696cf007203',
    expected_service: 'Streetscape_Projects',
    layer: 41,
    stable_key: ['FID', ...GENERIC_KEYS],
    scope: 'citywide',
    cadence: 'weekly',
    allowlist: { exclude_fields: ['contactinfo'] },
    notes: 'Layer id 41 ("Streetscapes"), 32 polylines citywide. Contact info not ingested.',
  }),
  city({
    id: 'city-parks',
    title: 'City Parks',
    item_id: '913df13c75fc4fba8320d95d92e3abc1',
    expected_service: 'city_parks',
    stable_key: ['park_id', ...GENERIC_KEYS],
    scope: 'citywide',
    cadence: 'weekly',
  }),
  city({
    id: 'street-centerline',
    title: 'Detroit Street Centerline',
    item_id: '447a5590746049acac50dbfd782a6284',
    expected_service: 'Detroit_Street_Centerline',
    stable_key: ['OBJECTID_1', ...GENERIC_KEYS],
    scope: 'polygon',
    cadence: 'monthly',
    notes: 'Layer last edited 2019-11; rendered for street lumen only. Not OSM.',
  }),
];

export function getSource(id: string): SourceDefinition {
  const source = SOURCES.find((s) => s.id === id);
  if (!source) {
    throw new Error(`unknown source "${id}"; known: ${SOURCES.map((s) => s.id).join(', ')}`);
  }
  return source;
}

/**
 * Applies the allowlist policy to a layer's live field list. Returns kept field names in layer
 * order. `keepOnly`, when given, further restricts the result (exclusions still win).
 */
export function computeAllowedFields(fields: readonly LayerField[], policy: FieldAllowlist, keepOnly?: readonly string[]): string[] {
  const keep = keepOnly ? new Set(keepOnly.map((n) => n.toLowerCase())) : null;
  return fields
    .map((f) => f.name)
    .filter((name) => isFieldAllowed(name, policy))
    .filter((name) => !keep || keep.has(name.toLowerCase()));
}

export function isFieldAllowed(name: string, policy: FieldAllowlist): boolean {
  if (policy.always_allow.includes(name)) return true;
  if (policy.exclude_fields.includes(name)) return false;
  return !policy.exclude_prefixes.some((prefix) => name.startsWith(prefix));
}

export interface ResolvedService {
  source_id: string;
  item_id: string;
  item_title: string;
  service_url: string;
  layer_url: string;
  matches_expected: boolean;
}

interface ArcgisItem {
  id?: string;
  title?: string;
  type?: string;
  url?: string;
  access?: string;
}

/** Resolves the FeatureServer URL from the ArcGIS item at runtime. */
export async function resolveServiceUrl(http: HttpClient, source: SourceDefinition): Promise<ResolvedService> {
  const item = await http.getJson<ArcgisItem>(buildUrl(`${ARCGIS_ITEM_ROOT}${source.item_id}`, { f: 'json' }));
  if (!item.url || item.type !== 'Feature Service') {
    throw new Error(`item ${source.item_id} (${source.id}) is not a Feature Service or has no url: ${JSON.stringify(item)}`);
  }
  const serviceUrl = item.url.replace(/\/+$/, '');
  const expected = `${ARCGIS_ORG_ROOT}${source.expected_service}/FeatureServer`;
  return {
    source_id: source.id,
    item_id: source.item_id,
    item_title: item.title ?? '',
    service_url: serviceUrl,
    layer_url: `${serviceUrl}/${source.layer}`,
    matches_expected: serviceUrl === expected,
  };
}
