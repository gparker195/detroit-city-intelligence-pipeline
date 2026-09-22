import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAllowedFields, DEFAULT_FIELD_ALLOWLIST, getSource, isFieldAllowed, SOURCES, CITY_OPEN_DATA_DISCLAIMER, ZONING_MAP_DISCLAIMER } from '../src/registry/sources.ts';
import { prepareRecords } from '../src/snapshot/store.ts';
import { fixture } from './helpers/fakeArcgis.ts';

const blightLayer = fixture<{ fields: { name: string; type: string }[] }>('layer.blight-tickets.json');

test('blight-tickets allowlist strips property_owner_* and inspector_name from the live field list', () => {
  const source = getSource('blight-tickets');
  const allowed = computeAllowedFields(blightLayer.fields, source.field_allowlist);
  const dropped = blightLayer.fields.map((f) => f.name).filter((n) => !allowed.includes(n));
  assert.ok(dropped.includes('inspector_name'));
  assert.ok(dropped.includes('property_owner_name'));
  assert.ok(dropped.includes('property_owner_address'));
  assert.ok(dropped.every((n) => n.startsWith('property_owner_') || n.startsWith('inspector_')));
  assert.ok(allowed.includes('ticket_id'));
  assert.ok(allowed.includes('parcel_id'));
  assert.ok(allowed.includes('ordinance_description'));
  assert.equal(dropped.length, 11, `expected the 11 live owner/inspector fields, got ${dropped.join(',')}`);
});

test('prepareRecords drops excluded attributes from every row', () => {
  const source = getSource('blight-tickets');
  const allowed = computeAllowedFields(blightLayer.fields, source.field_allowlist);
  const features = [
    { attributes: { OBJECTID: 1, ticket_id: 55, parcel_id: '01', inspector_name: 'X', property_owner_name: 'Y', property_owner_city: 'Z' }, geometry: { x: 1, y: 2 } },
  ];
  const { records, rejected } = prepareRecords(features, 'ticket_id', allowed);
  assert.equal(rejected.length, 0);
  assert.deepEqual(records[0]!.attributes, { OBJECTID: 1, ticket_id: 55, parcel_id: '01' });
  assert.equal(records[0]!.key, '55');
});

test('default policy keeps taxpayer_1/2 (owner of record as published) but drops taxpayer address and owner_name', () => {
  for (const name of ['taxpayer_1', 'taxpayer_2', 'parcel_id', 'zoning_district']) assert.equal(isFieldAllowed(name, DEFAULT_FIELD_ALLOWLIST), true, name);
  for (const name of ['taxpayer_address', 'taxpayer_city', 'taxpayer_state', 'taxpayer_zip_code', 'owner_name', 'property_owner_id', 'inspector_id']) {
    assert.equal(isFieldAllowed(name, DEFAULT_FIELD_ALLOWLIST), false, name);
  }
  assert.ok(getSource('vacant-property-registrations').field_allowlist.exclude_fields.includes('owner_name'));
});

test('every registry entry carries governance metadata', () => {
  assert.equal(SOURCES.length, 37);
  assert.equal(new Set(SOURCES.map((s) => s.id)).size, SOURCES.length, 'source ids are unique');
  assert.equal(new Set(SOURCES.map((s) => s.item_id)).size, SOURCES.length, 'item ids are unique');
  const layerOverrides: Record<string, number> = { 'row-permits': 5, 'streetscape-projects': 41 };
  for (const s of SOURCES) {
    assert.equal(s.open_data_disclaimer, CITY_OPEN_DATA_DISCLAIMER, s.id);
    assert.equal(s.lifecycle, 'active', s.id);
    assert.equal(s.terms_verified_on, '2026-09-21', s.id);
    assert.match(s.item_id, /^[0-9a-f]{32}$/, s.id);
    assert.equal(s.layer, layerOverrides[s.id] ?? 0, s.id);
    assert.ok(['polygon', 'buffer', 'citywide'].includes(s.scope), s.id);
    assert.ok(s.stable_key.length > 0, s.id);
    assert.ok(s.field_allowlist.exclude_prefixes.includes('property_owner_'), s.id);
    assert.ok(s.field_allowlist.exclude_prefixes.includes('inspector_'), s.id);
    assert.ok(s.field_allowlist.exclude_fields.includes('owner_name'), s.id);
  }
  assert.equal(getSource('zoning').disclaimer_text, ZONING_MAP_DISCLAIMER);
  assert.equal(getSource('building-permits').disclaimer_text, null);
  assert.match(getSource('liquor-licenses').attribution, /Michigan Liquor Control Commission \/ LARA/);
});

test('milestone 1 feeds exclude person-level fields: certification register contacts, sales parties, 311 requester, rental owners', () => {
  const reg = getSource('business-certification-register').field_allowlist;
  for (const f of ['authorized_contact_first_name', 'authorized_contact_last_name', 'business_phone_number']) assert.equal(isFieldAllowed(f, reg), false, f);
  assert.equal(isFieldAllowed('business_name', reg), true);
  const sales = getSource('property-sales').field_allowlist;
  assert.equal(isFieldAllowed('grantor', sales), false);
  assert.equal(isFieldAllowed('grantee', sales), false);
  assert.equal(isFieldAllowed('amt_sale_price', sales), true);
  const rental = getSource('rental-registrations').field_allowlist;
  assert.equal(isFieldAllowed('owner_name', rental), false);
  assert.equal(isFieldAllowed('owner_address', rental), false);
  const eleven = getSource('improve-detroit-311');
  const live = ['issue_id', 'request_type', 'status', 'created_at', 'closed_at', 'issue_url', 'address_id', 'longitude', 'latitude', 'ObjectId'].map((name) => ({ name, type: 'x' }));
  const kept = computeAllowedFields(live, eleven.field_allowlist, eleven.keep_only);
  assert.ok(!kept.includes('issue_url'));
  assert.deepEqual(kept, ['issue_id', 'request_type', 'status', 'created_at', 'closed_at', 'address_id', 'longitude', 'latitude', 'ObjectId']);
  const footprints = getSource('building-footprints');
  const fpLive = ['FID', 'bldgID', 'parcelID', 'MEDIAN_HGT', 'LOADD1', 'AKA', 'STORIES'].map((name) => ({ name, type: 'x' }));
  assert.deepEqual(computeAllowedFields(fpLive, footprints.field_allowlist, footprints.keep_only), ['FID', 'bldgID', 'parcelID', 'MEDIAN_HGT', 'STORIES']);
});
