// End-to-end API tests for the modules added in migrations 016-023:
// admin master data & config, geography, disclaimers, content guard,
// public search, CMS, business leads, CRM gap endpoints, NRI / HNI,
// investment tools, opportunity deals (incl. ingestion) and the customer
// portal (buyer / tenant / seller / owner dashboard, rentals, referrals).
//
// Runs against a live server + its database (the one in .env):
//   npm run dev                       # in one terminal
//   OPPORTUNITY_INGEST_SECRET must match between the server and this run
//   npm test                          # BASE_URL defaults to http://localhost:$PORT/api
//
// Test users are inserted straight into the database with unique emails,
// so the suite can run repeatedly. It refuses to run with NODE_ENV=production.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../src/config/db');

if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run e2e tests against production');

const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5001}/api`;
const INGEST_SECRET = process.env.OPPORTUNITY_INGEST_SECRET;
const RUN = crypto.randomBytes(3).toString('hex');
const PASSWORD = 'Passw0rd!e2e';

async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, data: json?.data };
}

async function createUser(role, label) {
  const email = `${label}.${RUN}@e2e.test`;
  const hash = await bcrypt.hash(PASSWORD, 10);
  const r = await pool.query(
    `INSERT INTO users (role_id, full_name, email, mobile, password_hash, status, email_verified)
     SELECT id, $2, $3, $4, $5, 'active', true FROM roles WHERE name = $1 RETURNING id`,
    [role, `${label} ${RUN}`, email, `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`, hash]
  );
  const login = await api('POST', '/auth/login', { body: { identifier: email, password: PASSWORD } });
  assert.equal(login.status, 200, `login failed for ${role}: ${JSON.stringify(login.body)}`);
  return { id: r.rows[0].id, token: login.data.accessToken, email };
}

// Module 46: OTP-verified professional fee consent -> one-time token.
async function consent(token, kind = 'listing') {
  const otp = await api('POST', '/mandates/consent/otp', { token });
  assert.equal(otp.status, 200, JSON.stringify(otp.body));
  const v = await api('POST', '/mandates/consent/verify', { token, body: { otp: otp.data.otp, kind } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return v.data.consentToken;
}

const ctx = {};
const CITY = `E2E City ${RUN}`;
const CITY_SLUG = `e2e-city-${RUN}`;
const PINCODE = String(parseInt(RUN, 16) % 900000 + 100000);

before(async () => {
  ctx.superAdmin = await createUser('super_admin', 'root');
  ctx.admin = await createUser('admin', 'admin');
  ctx.sales = await createUser('internal_sales', 'rm');
  ctx.broker = await createUser('broker', 'broker');
  ctx.customer = await createUser('customer', 'investor');
  ctx.casual = await createUser('customer', 'casual');
});

after(async () => {
  await pool.end();
});

// ------------------------------------------------------------------ admin

test('admin master data: city addition flow via admin APIs + CSV', async () => {
  const S = ctx.superAdmin.token;
  const state = await pool.query(`SELECT id FROM states WHERE state_code = 'TG'`);
  const activate = await api('PUT', `/admin/master/states/${state.rows[0].id}`, { token: S, body: { isActive: true } });
  assert.equal(activate.status, 200);

  const city = await api('POST', '/admin/master/cities', {
    token: S,
    body: { state: 'TG', cityName: CITY, slug: CITY_SLUG, status: 'inactive', cityTier: 1 },
  });
  assert.equal(city.status, 201, JSON.stringify(city.body));
  ctx.cityId = city.data.id;

  const loc = await api('POST', '/admin/master/localities/import', {
    token: S,
    body: { csv: `city,locality_name,pincode\n${CITY_SLUG},Alpha Nagar,${PINCODE}\n${CITY_SLUG},"Beta, Phase 2",` },
  });
  assert.equal(loc.status, 201, JSON.stringify(loc.body));
  assert.equal(loc.data.imported, 2);

  const bad = await api('POST', '/admin/master/localities/import', { token: S, body: { csv: 'city,locality_name\nno-such-city,X' } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.errors[0].row, 2);

  const dry = await api('POST', '/admin/master/stamp_duty_rules/import?dryRun=true', {
    token: S,
    body: { csv: `state,city,rate_percent,registration_fee_percent\nTG,${CITY_SLUG},6,0.5` },
  });
  assert.equal(dry.status, 200);
  assert.equal(dry.data.dryRun, true);

  const duty = await api('POST', '/admin/master/stamp_duty_rules/import', {
    token: S,
    body: { csv: `state,city,rate_percent,registration_fee_percent\nTG,${CITY_SLUG},6,0.5` },
  });
  assert.equal(duty.status, 201);

  const circle = await api('POST', '/admin/master/circle_rates', {
    token: S,
    body: { city: CITY_SLUG, locality: 'Alpha Nagar', ratePerSqft: 5200, propertyType: 'apartment' },
  });
  assert.equal(circle.status, 201, JSON.stringify(circle.body));

  const sro = await api('POST', '/admin/master/sub_registrar_offices', {
    token: S,
    body: { city: CITY_SLUG, sroName: 'SRO Alpha', jurisdictionLocalities: 'Alpha Nagar|Beta, Phase 2' },
  });
  assert.equal(sro.status, 201);
  assert.deepEqual(sro.data.jurisdiction_localities, ['Alpha Nagar', 'Beta, Phase 2']);

  // Inactive cities are invisible publicly until switched on.
  let pub = await api('GET', `/geo/cities/${CITY_SLUG}`);
  assert.equal(pub.status, 404);
  const on = await api('PUT', `/admin/master/cities/${ctx.cityId}`, { token: S, body: { status: 'active' } });
  assert.equal(on.status, 200);
  assert.equal(on.data.slug, CITY_SLUG, 'slug must not change on update');
  pub = await api('GET', `/geo/cities/${CITY_SLUG}`);
  assert.equal(pub.status, 200);

  const locs = await api('GET', `/geo/localities?citySlug=${CITY_SLUG}`);
  assert.equal(locs.data.length, 2);
  const dutyPub = await api('GET', `/geo/stamp-duty?stateCode=TG&cityId=${ctx.cityId}`);
  assert.equal(dutyPub.data.rules[0].rate_percent, '6.000');
  assert.equal(dutyPub.data.rules[0].effective_from.length, 10, 'DATE comes back as YYYY-MM-DD');
  const rate = await api('GET', `/geo/circle-rate?cityId=${ctx.cityId}&propertyType=apartment`);
  assert.equal(rate.status, 200);
});

test('admin config: statutory keys need super_admin; changes are audit-logged; audit log is append-only', async () => {
  const forbidden = await api('PUT', '/admin/config/tax.cess_percent', { token: ctx.admin.token, body: { value: 4 } });
  assert.equal(forbidden.status, 403);
  const ok = await api('PUT', '/admin/config/tax.cess_percent', { token: ctx.superAdmin.token, body: { value: 4, reason: 'e2e no-op' } });
  assert.equal(ok.status, 200);

  const logs = await api('GET', '/admin/audit-logs?entityType=app_config&entityId=tax.cess_percent', { token: ctx.admin.token });
  assert.ok(logs.data.items.length >= 1);

  await assert.rejects(pool.query('DELETE FROM audit_logs WHERE id = $1', [logs.data.items[0].id]), /append-only/);
  await assert.rejects(pool.query(`UPDATE audit_logs SET action = 'x' WHERE id = $1`, [logs.data.items[0].id]), /append-only/);

  const brokerDenied = await api('GET', '/admin/config', { token: ctx.broker.token });
  assert.equal(brokerDenied.status, 403);
});

test('disclaimers render by content type', async () => {
  const r = await api('GET', '/disclaimers?contentType=auction');
  const keys = r.data.map((d) => d.key);
  assert.ok(keys.includes('auction') && keys.includes('all_listings'));
  assert.ok(!keys.includes('loan'));
});

// ---------------------------------------------------------- content guard

const baseListing = () => ({
  title: `E2E Flat ${RUN}`,
  propertyType: 'apartment',
  transactionType: 'sell',
  price: '2.1 Cr',
  city: CITY,
  locality: 'Alpha Nagar',
  address: 'Private street address 42',
  latitude: 17.4401234,
  longitude: 78.3489876,
  areaSqft: 1450,
  bedrooms: 3,
});

test('content guard rejects contact details, forbidden terms and brand misspellings in listings', async () => {
  const B = ctx.broker.token;
  const cases = [
    [{ description: 'Great flat, call 98765 43210 today' }, 'phone_number'],
    [{ description: 'mail owner@example.com' }, 'email'],
    [{ description: 'see www.example.com' }, 'url'],
    [{ description: 'Please contact karo for visit' }, 'contact_phrase'],
    [{ title: 'Distressed sale near metro' }, 'forbidden_term'],
    [{ description: 'Guaranteed returns of 20%' }, 'forbidden_term'],
    [{ description: 'Listed by A R Buildwell' }, 'brand_spelling'],
    [{ faqs: [{ question: 'Why?', answer: 'It is cheap' }] }, 'forbidden_term'],
  ];
  for (const [patch, rule] of cases) {
    const r = await api('POST', '/properties', { token: B, body: { ...baseListing(), ...patch } });
    assert.equal(r.status, 422, `expected 422 for ${JSON.stringify(patch)}`);
    assert.ok(r.body.errors.some((e) => e.rule === rule), `expected rule ${rule}, got ${JSON.stringify(r.body.errors)}`);
  }

  const clean = await api('POST', '/properties', { token: B, body: { ...baseListing(), description: 'Sunny 3 BHK, park facing.' } });
  assert.equal(clean.status, 201, JSON.stringify(clean.body));
  assert.equal(Number(clean.data.price_value), 21000000, 'free-text price parsed into price_value');
  ctx.residentialId = clean.data.id;
  const approve = await api('PUT', `/properties/${ctx.residentialId}/approve`, { token: ctx.admin.token });
  assert.equal(approve.status, 200);

  const pricing = await api('PUT', `/properties/${ctx.residentialId}/pricing`, { token: B, body: { price: '85 Lakh' } });
  assert.equal(Number(pricing.data.price_value), 8500000);
});

// -------------------------------------------------------- opportunities

test('opportunity listing: scores computed, approval alerts matched verified investors', async () => {
  const C = ctx.customer.token;
  // Investor profile - unverified first.
  const profile = await api('PUT', '/investors/me', {
    token: C,
    body: {
      isNri: true,
      isHni: true,
      residencyStatus: 'nri',
      countryOfResidence: 'United Arab Emirates',
      preferredCities: [CITY],
      assetClassPreferences: ['auction', 'special_situation', 'residential'],
      ticketSizeMin: 1000000,
      ticketSizeMax: 500000000,
    },
  });
  assert.equal(profile.status, 200, JSON.stringify(profile.body));
  ctx.profileId = profile.data.id;
  assert.equal(profile.data.verification_status, 'pending');

  const access = await api('GET', '/opportunities/access', { token: C });
  assert.equal(access.data.full, false);

  const created = await api('POST', '/properties', {
    token: ctx.admin.token,
    body: {
      ...baseListing(),
      title: `Bank auction 3 BHK ${RUN}`,
      listingCategory: 'auction',
      price: '1.2 Cr',
      reservePrice: 12000000,
      estimatedMarketValue: 16000000,
      emdAmount: 1200000,
      auctionDate: new Date(Date.now() + 10 * 86400000).toISOString(),
      sourceBank: 'State Bank of India',
      auctionReferenceId: `SBI-${RUN}`,
      opportunitySourceType: 'sarfaesi_bank_auction',
      possessionType: 'physical',
      riskIndicators: ['documentation_pending'],
      estimatedRentMonthly: 45000,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ctx.auctionId = created.data.id;
  assert.equal(Number(created.data.discount_percent), 25);
  assert.ok(created.data.investment_score > 0 && created.data.investment_score <= 100);
  assert.ok(created.data.score_breakdown.components);

  // Verify the investor, then approve the listing -> alert.
  const verify = await api('PUT', `/investors/${ctx.profileId}/verify`, { token: ctx.sales.token, body: { status: 'verified' } });
  assert.equal(verify.status, 200);
  const assign = await api('PUT', `/investors/${ctx.profileId}/assign-manager`, { token: ctx.admin.token, body: { managerId: ctx.sales.id } });
  assert.equal(assign.status, 200);

  const approve = await api('PUT', `/properties/${ctx.auctionId}/approve`, { token: ctx.admin.token });
  assert.equal(approve.status, 200);
  await new Promise((r) => setTimeout(r, 400)); // alerts are fire-and-forget
  const alerts = await pool.query('SELECT * FROM opportunity_alert_log WHERE property_id = $1 AND user_id = $2', [ctx.auctionId, ctx.customer.id]);
  assert.equal(alerts.rows.length, 1, 'matched verified investor alerted once');
  const again = await api('POST', `/opportunities/${ctx.auctionId}/send-alerts`, { token: ctx.admin.token });
  assert.equal(again.data.sent, 0, 'no duplicate alert');
});

test('opportunity access: teaser for casual users, full for verified investor; search hides it by default', async () => {
  const teaser = await api('GET', `/opportunities/public?listingCategory=auction&city=${encodeURIComponent(CITY)}`);
  assert.equal(teaser.status, 200);
  const item = teaser.data.items.find((i) => i.id === ctx.auctionId);
  assert.ok(item, 'auction appears in public teaser list');
  assert.equal(item.locked, true);
  assert.equal(item.source_bank, undefined);
  assert.equal(item.auction_reference_id, undefined);
  assert.ok(teaser.data.disclaimers.some((d) => d.key === 'auction'));

  const casualDetail = await api('GET', `/opportunities/${ctx.auctionId}`, { token: ctx.casual.token });
  assert.equal(casualDetail.data.locked, true);
  const casualList = await api('GET', '/opportunities', { token: ctx.casual.token });
  assert.equal(casualList.status, 403);

  const full = await api('GET', `/opportunities/${ctx.auctionId}`, { token: ctx.customer.token });
  assert.equal(full.data.access.full, true);
  assert.equal(full.data.source_bank, 'State Bank of India');
  assert.equal(full.data.address, undefined, 'investor never gets the private address');

  const search = await api('GET', `/search/properties?city=${encodeURIComponent(CITY)}`);
  assert.ok(!search.data.items.some((i) => i.id === ctx.auctionId), 'auction excluded from default search');
  const resi = search.data.items.find((i) => i.id === ctx.residentialId);
  assert.ok(resi, 'residential listing searchable');
  assert.equal(resi.address, undefined);
  assert.equal(resi.latitude, 17.44, 'coordinates rounded publicly');
  assert.ok(search.data.disclaimers.length > 0);

  const auctionSearch = await api('GET', `/search/properties?listingCategory=auction&city=${encodeURIComponent(CITY)}`);
  assert.equal(auctionSearch.data.items[0].locked, true);

  const detail = await api('GET', `/search/properties/${ctx.residentialId}`);
  assert.equal(detail.data.address, undefined);
  const home = await api('GET', '/search/home');
  assert.equal(home.status, 200);
  assert.ok('stats' in home.data && 'auctionHighlights' in home.data);
});

test('opportunity interest pipeline: lead created, one stage at a time, drop needs a reason', async () => {
  const denied = await api('POST', `/opportunities/${ctx.auctionId}/interest`, { token: ctx.casual.token, body: {} });
  assert.equal(denied.status, 403);

  const interest = await api('POST', `/opportunities/${ctx.auctionId}/interest`, {
    token: ctx.customer.token,
    body: { intendedBidAmount: 12500000, financingNeeded: true, message: 'Interested, need loan support' },
  });
  assert.equal(interest.status, 201, JSON.stringify(interest.body));
  ctx.interestId = interest.data.id;
  assert.equal(interest.data.stage, 'lead');
  assert.equal(interest.data.assigned_to, ctx.sales.id, 'routed to the investor manager');
  const lead = await pool.query('SELECT source, assigned_to FROM leads WHERE id = $1', [interest.data.lead_id]);
  assert.equal(lead.rows[0].source, 'opportunity');

  const repeat = await api('POST', `/opportunities/${ctx.auctionId}/interest`, { token: ctx.customer.token, body: {} });
  assert.equal(repeat.status, 200);

  const skip = await api('PUT', `/opportunities/interests/${ctx.interestId}/stage`, { token: ctx.sales.token, body: { stage: 'negotiation' } });
  assert.equal(skip.status, 400);
  const next = await api('PUT', `/opportunities/interests/${ctx.interestId}/stage`, { token: ctx.sales.token, body: { stage: 'deal_interest' } });
  assert.equal(next.status, 200);
  const dropNoReason = await api('PUT', `/opportunities/interests/${ctx.interestId}/stage`, { token: ctx.sales.token, body: { stage: 'dropped' } });
  assert.equal(dropNoReason.status, 400);
  const customerCantMove = await api('PUT', `/opportunities/interests/${ctx.interestId}/stage`, { token: ctx.customer.token, body: { stage: 'due_diligence' } });
  assert.equal(customerCantMove.status, 403);

  const mine = await api('GET', '/opportunities/interests', { token: ctx.customer.token });
  assert.ok(mine.data.items.some((i) => i.id === ctx.interestId));
  const detail = await api('GET', `/opportunities/interests/${ctx.interestId}`, { token: ctx.customer.token });
  assert.equal(detail.data.history.length, 2);

  const summary = await api('GET', '/opportunities/summary', { token: ctx.sales.token });
  assert.equal(summary.status, 200);
});

test('opportunity ingestion: crawler secret, normalisation, dedupe, review, publish, reject, CSV', async () => {
  if (!INGEST_SECRET) return;
  const ref = `IBAPI-${RUN}`;
  const raw = {
    title: `Residential flat in ${CITY} - contact AO at 9876543210`,
    bank: 'Bank of Baroda',
    reserve_price: '85 Lakh',
    emd: '8.5 Lakh',
    auction_date: '28/12/2030 11:30 AM',
    city: CITY,
    locality: 'Beta, Phase 2',
    area: '150 sq yd',
    possession: 'Symbolic possession',
    auction_id: ref,
    description: 'Flat on 2nd floor. For details call the Authorised Officer on 9876543210. Near market.',
  };
  const noAuth = await api('POST', '/opportunities/ingest', { body: { sourceName: 'crawler_ibapi', items: [raw] } });
  assert.equal(noAuth.status, 401);

  const ingest = await api('POST', '/opportunities/ingest', {
    headers: { 'x-ingest-secret': INGEST_SECRET },
    body: { sourceName: 'crawler_ibapi', items: [raw] },
  });
  assert.equal(ingest.status, 201, JSON.stringify(ingest.body));
  assert.equal(ingest.data.needs_review, 1);
  const itemId = ingest.data.items[0].id;

  const item = await api('GET', `/opportunities/ingest/${itemId}`, { token: ctx.admin.token });
  const n = item.data.normalised;
  assert.equal(n.reserve_price, 8500000);
  assert.equal(n.emd_amount, 850000);
  assert.equal(n.area_sqft, 1350);
  assert.equal(n.possession_type, 'symbolic');
  assert.equal(n.opportunity_source_type, 'sarfaesi_bank_auction');
  assert.equal(n.auction_date, '2030-12-28T06:00:00.000Z');
  assert.ok(!/9876543210/.test(n.description) && !/9876543210/.test(n.title), 'contact details stripped');

  const again = await api('POST', '/opportunities/ingest', {
    headers: { 'x-ingest-secret': INGEST_SECRET },
    body: { sourceName: 'crawler_ibapi', items: [raw] },
  });
  assert.equal(again.data.skipped_existing, 1);

  const published = await api('POST', `/opportunities/ingest/${itemId}/publish`, { token: ctx.admin.token, body: { notes: 'checked' } });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  assert.equal(published.data.status, 'approved');
  assert.equal(published.data.data_source, 'crawler');

  // Same deal from another source is flagged duplicate against the live listing.
  const dup = await api('POST', '/opportunities/ingest', {
    token: ctx.admin.token,
    body: { sourceName: 'manual_api', items: [{ ...raw, auction_id: `${ref}-X`, bank: 'Bank of Baroda' }] },
  });
  assert.equal(dup.data.duplicate, 1);
  const rejected = await api('POST', `/opportunities/ingest/${dup.data.items[0].id}/reject`, { token: ctx.admin.token, body: { notes: 'duplicate' } });
  assert.equal(rejected.data.status, 'rejected');

  const csv = await api('POST', '/opportunities/ingest/csv', {
    token: ctx.admin.token,
    body: { csv: `title,bank,reserve_price,auction_date,city,auction_id\nShop unit ${RUN},Canara Bank,40 Lakh,15-01-2031,${CITY},CAN-${RUN}` },
  });
  assert.equal(csv.status, 201, JSON.stringify(csv.body));
  assert.equal(csv.data.received, 1);

  const queue = await api('GET', '/opportunities/ingest/queue?status=needs_review', { token: ctx.admin.token });
  assert.ok(queue.data.countsByStatus.published >= 1);
});

// ------------------------------------------------------------------ NRI

test('NRI: properties (masked tenant phone), rent ledger, service requests, repatriation, dashboard, guidance', async () => {
  const C = ctx.customer.token;
  const S = ctx.sales.token;

  const prop = await api('POST', '/nri/properties', {
    token: C,
    body: {
      title: 'Family flat',
      city: CITY,
      locality: 'Alpha Nagar',
      purchasePrice: 9000000,
      purchaseDate: '2018-05-10',
      currentEstimatedValue: 14000000,
      occupancyStatus: 'tenant_occupied',
      monthlyRentExpected: 40000,
      tenantName: 'Tenant One',
      tenantPhone: '9812345678',
      managementStatus: 'platform_managed',
    },
  });
  assert.equal(prop.status, 201, JSON.stringify(prop.body));
  assert.equal(prop.data.tenant_phone_masked, '98XXXXXX78');
  assert.equal(prop.data.tenant_phone_encrypted, undefined);
  const stored = await pool.query('SELECT tenant_phone_encrypted FROM nri_properties WHERE id = $1', [prop.data.id]);
  assert.ok(stored.rows[0].tenant_phone_encrypted.startsWith('v1:'));

  const rentPartial = await api('POST', `/nri/properties/${prop.data.id}/rent`, { token: S, body: { periodMonth: '2026-08-15', rentReceived: 20000 } });
  assert.equal(rentPartial.data.status, 'partial');
  assert.equal(rentPartial.data.period_month, '2026-08-01');
  const rentFull = await api('POST', `/nri/properties/${prop.data.id}/rent`, { token: S, body: { periodMonth: '2026-08-01', rentReceived: 40000, tdsDeducted: 12480 } });
  assert.equal(rentFull.data.status, 'received');

  const reqCreated = await api('POST', '/nri/service-requests', {
    token: C,
    body: { requestType: 'rent_collection', title: 'Follow up September rent', nriPropertyId: prop.data.id, priority: 'high' },
  });
  assert.equal(reqCreated.status, 201, JSON.stringify(reqCreated.body));
  const reqId = reqCreated.data.id;
  assert.equal(reqCreated.data.assigned_manager_id, ctx.sales.id);
  assert.ok(reqCreated.data.sla_due_at);

  const customerCantProgress = await api('PUT', `/nri/service-requests/${reqId}/status`, { token: C, body: { status: 'in_progress' } });
  assert.equal(customerCantProgress.status, 403);
  await api('POST', `/nri/service-requests/${reqId}/updates`, { token: S, body: { message: 'Internal: tenant slow payer', isInternal: true } });
  const progressed = await api('PUT', `/nri/service-requests/${reqId}/status`, { token: S, body: { status: 'in_progress', message: 'Spoke to tenant' } });
  assert.equal(progressed.status, 200);
  assert.ok(progressed.data.first_response_at);

  const customerView = await api('GET', `/nri/service-requests/${reqId}`, { token: C });
  assert.ok(!customerView.data.timeline.some((t) => t.is_internal), 'internal notes hidden from investor');
  const staffView = await api('GET', `/nri/service-requests/${reqId}`, { token: S });
  assert.ok(staffView.data.timeline.some((t) => t.is_internal));

  const outsider = await api('GET', `/nri/service-requests/${reqId}`, { token: ctx.casual.token });
  assert.equal(outsider.status, 404);

  const rep = await api('POST', '/nri/repatriation', {
    token: C,
    body: { source: 'rental_income', amountInr: 4000000, amountUsdEquivalent: 48000, status: 'completed', financialYear: '2026-27' },
  });
  assert.equal(rep.status, 201);
  assert.equal(rep.data.summary.completedUsd, 48000);
  assert.equal(rep.data.withinLimit, true);

  const dash = await api('GET', '/nri/dashboard', { token: C });
  assert.equal(dash.status, 200);
  assert.equal(dash.data.portfolio.properties, 1);
  assert.equal(dash.data.assignedManager.id, ctx.sales.id);
  const staffDash = await api('GET', `/nri/dashboard?investorId=${ctx.profileId}`, { token: S });
  assert.equal(staffDash.status, 200);
  const staffNoId = await api('GET', '/nri/dashboard', { token: S });
  assert.equal(staffNoId.status, 400);

  const tds = await api('POST', '/nri/guidance/tds-on-sale', {
    body: { salePrice: 15000000, purchasePrice: 9000000, holdingMonths: 60 },
  });
  assert.equal(tds.data.gainType, 'long_term');
  assert.equal(tds.data.capitalGain, 6000000);
  // 6,000,000 x 12.5% = 750,000; surcharge 10% (gain > 50L) = 75,000; cess 4% = 33,000
  assert.equal(tds.data.tdsOnCapitalGain.total, 858000);
  assert.ok(tds.data.disclaimers.length > 0);

  const fema = await api('GET', '/nri/guidance/fema');
  assert.ok(fema.data.points.length > 0);
});

// ------------------------------------------------------------------ HNI

test('HNI: portfolio metrics, summary, curated deals, shortlist, behaviour', async () => {
  const C = ctx.customer.token;
  const inv = await api('POST', '/hni/portfolio', {
    token: C,
    body: {
      title: 'Office floor',
      assetClass: 'commercial',
      city: CITY,
      acquisitionDate: '2021-09-27',
      acquisitionCost: 20000000,
      additionalCosts: 1500000,
      currentValuation: 30000000,
      monthlyRentalIncome: 150000,
      annualExpenses: 100000,
    },
  });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const m = inv.data.metrics;
  assert.equal(m.total_cost, 21500000);
  assert.equal(m.gross_rental_yield_percent, 8.37);
  assert.ok(m.capital_cagr_percent > 6 && m.capital_cagr_percent < 8);

  const exitBad = await api('PUT', `/hni/portfolio/${inv.data.id}`, { token: C, body: { status: 'exited' } });
  assert.equal(exitBad.status, 400);

  const summary = await api('GET', '/hni/portfolio/summary', { token: C });
  assert.equal(summary.data.positions.active, 1);
  assert.equal(summary.data.totals.invested, 21500000);

  const deals = await api('GET', '/hni/deals', { token: C });
  assert.equal(deals.status, 200);
  assert.ok(deals.data.items.some((d) => d.id === ctx.auctionId));

  const track = await api('POST', `/hni/deals/${ctx.auctionId}/track`, { token: C, body: { action: 'shortlisted' } });
  assert.equal(track.status, 201);
  const shortlist = await api('GET', '/hni/shortlist', { token: C });
  assert.ok(shortlist.data.some((d) => d.id === ctx.auctionId));

  const dash = await api('GET', '/hni/dashboard', { token: C });
  assert.equal(dash.status, 200);
  assert.equal(dash.data.shortlistCount, 1);

  const behaviour = await api('GET', `/investors/${ctx.profileId}/behaviour`, { token: ctx.sales.token });
  assert.ok(behaviour.data.byAction.viewed >= 1);
  assert.ok(behaviour.data.byAction.shortlisted >= 1);
});

// --------------------------------------------------------------- content

test('CMS: articles, city page from template, sitemap', async () => {
  const A = ctx.admin.token;
  const blocked = await api('POST', '/content/manage/articles', { token: A, body: { title: 'Why Propertysearch is great' } });
  assert.equal(blocked.status, 422);

  const art = await api('POST', '/content/manage/articles', {
    token: A,
    body: { title: `NRI Guide ${RUN}`, contentHtml: '<p>word </p>'.repeat(450), category: 'NRI', tags: ['nri'], status: 'published', isFeatured: true },
  });
  assert.equal(art.status, 201, JSON.stringify(art.body));
  assert.equal(art.data.slug, `nri-guide-${RUN}`);
  assert.equal(art.data.reading_minutes, 2);

  const dupe = await api('POST', '/content/manage/articles', { token: A, body: { title: `NRI Guide ${RUN}` } });
  assert.equal(dupe.status, 422);

  const pubList = await api('GET', '/content/articles?category=NRI');
  assert.ok(pubList.data.items.some((a) => a.slug === art.data.slug));
  const one = await api('GET', `/content/articles/${art.data.slug}`);
  assert.equal(one.status, 200);

  const page = await api('POST', '/content/manage/city-pages', { token: A, body: { city: CITY_SLUG, pageType: 'buy', status: 'published' } });
  assert.equal(page.status, 201, JSON.stringify(page.body));
  assert.equal(page.data.slug, `buy-property-in-${CITY_SLUG}`);
  assert.equal(page.data.title, `Buy Property in ${CITY}`);
  const twice = await api('POST', '/content/manage/city-pages', { token: A, body: { city: CITY_SLUG, pageType: 'buy' } });
  assert.equal(twice.status, 422);

  const live = await api('GET', `/content/city-pages/buy-property-in-${CITY_SLUG}`);
  assert.equal(live.status, 200);
  assert.ok(live.data.stats.active_listings >= 1);
  assert.ok(live.data.featuredListings.some((l) => l.id === ctx.residentialId));

  const xml = await api('GET', '/content/sitemap.xml');
  assert.match(xml.body, new RegExp(`buy-property-in-${CITY_SLUG}`));
  assert.match(xml.body, new RegExp(art.data.slug));
});

// ------------------------------------------------------------ bd leads

test('business leads: per-category validation, advertiser eligibility, dedupe, assignment, city demand', async () => {
  const missing = await api('POST', '/bd-leads', { body: { category: 'franchisee', fullName: 'F', mobile: '9811111111' } });
  assert.equal(missing.status, 400);
  const ineligible = await api('POST', '/bd-leads', {
    body: { category: 'advertiser', fullName: 'Ad', email: `ad.${RUN}@e2e.test`, businessName: 'Crypto X', businessCategory: 'crypto_exchange' },
  });
  assert.equal(ineligible.status, 422);

  const fr = await api('POST', '/bd-leads', {
    body: { category: 'franchisee', fullName: `Franchise ${RUN}`, email: `fr.${RUN}@e2e.test`, territoryOfInterest: 'West Delhi' },
  });
  assert.equal(fr.status, 201);
  const frAgain = await api('POST', '/bd-leads', {
    body: { category: 'franchisee', fullName: `Franchise ${RUN}`, email: `fr.${RUN}@e2e.test`, territoryOfInterest: 'West Delhi' },
  });
  assert.equal(frAgain.status, 200);
  assert.equal(frAgain.data.id, fr.data.id);

  for (let i = 0; i < 2; i++) {
    await api('POST', '/bd-leads', { body: { category: 'city_addition', fullName: `C${i}`, email: `c${i}.${RUN}@e2e.test`, cityName: `Demandville ${RUN}` } });
  }
  const demand = await api('GET', '/bd-leads/city-demand', { token: ctx.admin.token });
  const row = demand.data.find((d) => d.city_name.toLowerCase() === `demandville ${RUN}`.toLowerCase());
  assert.equal(row.requests, 2);

  const salesCantSee = await api('GET', `/bd-leads/${fr.data.id}`, { token: ctx.sales.token });
  assert.equal(salesCantSee.status, 404);
  const assigned = await api('PUT', `/bd-leads/${fr.data.id}/assign`, { token: ctx.admin.token, body: { assignedTo: ctx.sales.id } });
  assert.equal(assigned.data.status, 'assigned');
  const status = await api('PUT', `/bd-leads/${fr.data.id}/status`, { token: ctx.sales.token, body: { status: 'contacted' } });
  assert.equal(status.data.status, 'contacted');
  const audit = await pool.query(`SELECT 1 FROM audit_logs WHERE entity_type = 'bd_lead' AND entity_id = $1 AND action = 'bd_lead_assigned'`, [fr.data.id]);
  assert.equal(audit.rows.length, 1);
});

// ---------------------------------------------------------- CRM gaps

test('CRM gaps: payments list/stats, AI insights/stats/review, trend report, unread count', async () => {
  const A = ctx.admin.token;
  const payments = await api('GET', '/payments', { token: A });
  assert.equal(payments.status, 200);
  assert.ok(Array.isArray(payments.data.items));
  const stats = await api('GET', '/payments/stats', { token: A });
  assert.ok('collected_amount' in stats.data);

  const trend = await api('GET', '/reports/trend?days=7', { token: A });
  assert.equal(trend.data.series.length, 7);
  assert.ok(trend.data.series[6].leads >= 1, 'today includes the opportunity lead');

  const unread = await api('GET', '/notifications/unread-count', { token: ctx.customer.token });
  assert.ok(unread.data.count >= 1, 'investor got alert / verification notifications');

  // AI review: seed an insight for the opportunity lead, then override it.
  const leadId = (await pool.query('SELECT lead_id FROM opportunity_interests WHERE id = $1', [ctx.interestId])).rows[0].lead_id;
  const noInsight = await api('POST', `/ai/lead/${leadId}/review`, { token: A, body: { action: 'confirm' } });
  assert.equal(noInsight.status, 404);
  await pool.query(`INSERT INTO ai_lead_insights (lead_id, summary, score, confidence) VALUES ($1, 'e2e', 'warm', 0.8)`, [leadId]);
  const override = await api('POST', `/ai/lead/${leadId}/review`, { token: A, body: { action: 'override', score: 'hot', reason: 'Bid ready' } });
  assert.equal(override.status, 201);
  const lead = await pool.query('SELECT status FROM leads WHERE id = $1', [leadId]);
  assert.equal(lead.rows[0].status, 'hot');

  const insights = await api('GET', '/ai/insights?reviewed=true', { token: A });
  const row = insights.data.items.find((i) => i.lead_id === leadId);
  assert.equal(row.effective_score, 'hot');
  const aiStats = await api('GET', '/ai/stats', { token: A });
  assert.ok(aiStats.data.manual_overrides >= 1);
});

// ----------------------------------------------------------------- tools

test('investment tools: roi, rental yield, appreciation, liquidity', async () => {
  const yieldR = await api('POST', '/tools/rental-yield', { body: { propertyPrice: 10000000, monthlyRent: 30000 } });
  assert.equal(yieldR.data.grossYieldPercent, 3.6);
  const appr = await api('POST', '/tools/appreciation', { body: { currentValue: 10000000, annualAppreciationPercent: 10, years: 2 } });
  assert.equal(appr.data.projectedValue, 12100000);
  const roi = await api('POST', '/tools/roi', { body: { purchasePrice: 10000000, annualAppreciationPercent: 0, holdingYears: 1, monthlyRent: 50000 } });
  assert.equal(roi.data.absoluteRoiPercent, 6);
  const liq = await api('GET', `/tools/liquidity-score?city=${encodeURIComponent(CITY)}`);
  assert.equal(liq.status, 200);
  assert.ok(['high', 'moderate', 'low', null].includes(liq.data.band));
  assert.ok(liq.data.disclaimers.length > 0);
});

// --------------------------------------------------------- customer portal

test('customer portal: onboarding + referral code, listing with consent, requirement -> hot match alert, masked seller view', async () => {
  const seller = await createUser('customer', 'seller');
  const buyer = await createUser('customer', 'buyer');
  const A = ctx.admin.token;

  const staff = await api('GET', '/me/overview', { token: A });
  assert.equal(staff.status, 403, 'staff use the CRM, not the customer dashboard');

  const onboarded = await api('PUT', '/me/profile', { token: seller.token, body: { portalRoles: ['seller', 'owner'] } });
  assert.equal(onboarded.status, 200);
  assert.match(onboarded.data.referral.code, /^SE-[A-HJKMNP-Z2-9]{5}$/);
  assert.equal(onboarded.data.tier.current, 'lite');
  const code = onboarded.data.referral.code;
  const again = await api('PUT', '/me/profile', { token: seller.token, body: { portalRoles: ['owner'] } });
  assert.equal(again.data.referral.code, code, 'referral code is permanent');

  // Referral attribution on sign-up; unknown code rejected.
  const badRef = await api('POST', '/auth/register', {
    body: { fullName: 'Ref Test', email: `badref.${RUN}@e2e.test`, password: PASSWORD, role: 'customer', referralCode: 'BU-ZZZZZ' },
  });
  assert.equal(badRef.status, 400);
  const referred = await api('POST', '/auth/register', {
    body: { fullName: 'Ref Test', email: `ref.${RUN}@e2e.test`, password: PASSWORD, role: 'customer', referralCode: code },
  });
  assert.equal(referred.status, 201);
  const edge = await pool.query('SELECT referrer_id FROM referral_tree WHERE referred_id = $1', [referred.data.id]);
  assert.equal(edge.rows[0].referrer_id, seller.id);
  await assert.rejects(pool.query('DELETE FROM referral_tree WHERE referred_id = $1', [referred.data.id]), /append-only/);

  const listingBody = {
    title: `3 BHK apartment Sector 56 ${RUN}`, propertyType: 'apartment', transactionType: 'sell', price: '1.5 Cr',
    city: CITY, locality: 'Sector 56', areaSqft: 1650, bedrooms: 3,
  };
  const noConsent = await api('POST', '/me/listings', { token: seller.token, body: { ...listingBody } });
  assert.equal(noConsent.status, 422, 'OTP consent token is mandatory');
  const withPhone = await api('POST', '/me/listings', { token: seller.token, body: { ...listingBody, title: 'Call 9876543210 now', consentToken: await consent(seller.token) } });
  assert.equal(withPhone.status, 422);
  const listing = await api('POST', '/me/listings', { token: seller.token, body: { ...listingBody, consentToken: await consent(seller.token), mandateType: 'exclusive', priceRange: { minPrice: 14000000, maxPrice: 15500000 } } });
  assert.equal(listing.status, 201);
  // Sec. 9.4 / 9.5: a new, unverified seller (+20) with an unverified mobile
  // (+10) listing above Rs 1 Cr scores Yellow - live at once, with the
  // Under Review banner and a 2-hour manual check.
  assert.equal(listing.data.status, 'approved');
  assert.equal(listing.data.fraud_band, 'yellow');
  assert.equal(listing.data.under_review, true);
  assert.equal(listing.data.is_verified, false);

  const req = await api('POST', '/me/requirements', {
    token: buyer.token,
    body: { purpose: 'buy', propertyType: 'apartment', city: CITY, localities: ['Sector 56'], budgetMin: 10000000, budgetMax: 20000000, bedrooms: 3, urgency: 'immediate', consentToken: await consent(buyer.token, 'requirement') },
  });
  assert.equal(req.status, 201);
  assert.equal(req.data.temperature, 'hot');
  const lead = await pool.query('SELECT status, source FROM leads WHERE id = $1', [req.data.lead_id]);
  assert.deepEqual(lead.rows[0], { status: 'hot', source: 'website' });

  assert.equal((await api('PUT', `/properties/${listing.data.id}/approve`, { token: A })).status, 200);
  await new Promise((r) => setTimeout(r, 500));
  const matches = await api('GET', '/me/matches', { token: buyer.token });
  const match = matches.data.items.find((m) => m.property.id === listing.data.id);
  assert.ok(match && match.hotMatch && match.score === 100);
  assert.equal(match.property.created_by, undefined, 'no owner identity in match cards');
  const alerts = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'match_alert' AND related_entity_id = $2`, [buyer.id, listing.data.id]);
  assert.equal(alerts.rows.length, 1);

  // Buyer enquires; seller sees the count and a first name, never contact details.
  await api('POST', '/leads/public-inquiry', { body: { fullName: `Buyer ${RUN}`, email: buyer.email, propertyId: listing.data.id } });
  const enquiries = await api('GET', '/me/enquiries', { token: buyer.token });
  const propEnquiry = enquiries.data.find((e) => e.property_id === listing.data.id);
  assert.ok(propEnquiry);
  const visitReq = await api('POST', `/me/enquiries/${propEnquiry.id}/visit-request`, {
    token: buyer.token,
    body: { preferredAt: new Date(Date.now() + 86400000).toISOString() },
  });
  assert.equal(visitReq.status, 200);
  const other = await api('POST', `/me/enquiries/${propEnquiry.id}/visit-request`, { token: seller.token, body: { preferredAt: new Date(Date.now() + 86400000).toISOString() } });
  assert.equal(other.status, 404, "cannot act on someone else's enquiry");

  const mine = await api('GET', '/me/listings', { token: seller.token });
  const row = mine.data.find((l) => l.id === listing.data.id);
  assert.equal(row.enquiry_count, 1);
  assert.ok(row.expires_at);
  const masked = await api('GET', `/me/listings/${listing.data.id}/enquiries`, { token: seller.token });
  assert.equal(masked.data[0].first_name, 'buyer');
  assert.equal(masked.data[0].email, undefined);
  assert.equal(masked.data[0].mobile, undefined);
  const notMine = await api('GET', `/me/listings/${listing.data.id}/enquiries`, { token: buyer.token });
  assert.equal(notMine.status, 404);

  assert.equal((await api('POST', `/me/listings/${listing.data.id}/renew`, { token: seller.token })).status, 200);
  const edited = await api('PUT', `/me/listings/${listing.data.id}`, { token: seller.token, body: { price: '1.45 Cr' } });
  // Edits go back through the checks; a non-Red listing is re-published at once (sec. 9.5).
  assert.equal(edited.data.status, 'approved', 'edits are re-checked and re-published');
  assert.ok((await pool.query(`SELECT 1 FROM fraud_assessments WHERE property_id = $1 AND trigger = 'update'`, [listing.data.id])).rows.length);
  assert.equal(Number(edited.data.price_value), 14500000);

  await api('PUT', `/properties/${listing.data.id}/approve`, { token: A });
  assert.equal((await api('POST', `/properties/${listing.data.id}/favorite`, { token: buyer.token })).status, 200);
  const favs = await api('GET', '/me/favourites', { token: buyer.token });
  assert.ok(favs.data.ids.includes(listing.data.id));
  assert.equal(favs.data.items[0].created_by_name, undefined);

  const saved = await api('POST', '/me/saved-searches', { token: buyer.token, body: { name: 'Big flats', filters: { purpose: 'buy', city: CITY, bedrooms: 3, evil: 'x' } } });
  assert.equal(saved.status, 201);
  assert.equal(saved.data.filters.evil, undefined);
});

test('rentals: owner adds lease, tenant confirms and reports rent, owner confirms, maintenance lifecycle', async () => {
  const owner = await createUser('customer', 'landlord');
  const tenant = await createUser('customer', 'tenant');
  const start = new Date();
  start.setMonth(start.getMonth() - 1);

  const lease = await api('POST', '/me/rentals', {
    token: owner.token,
    body: { propertyLabel: `Flat 402, ${CITY}`, tenantName: `Tenant ${RUN}`, tenantEmail: tenant.email, monthlyRent: 45000, securityDeposit: 90000, startDate: start.toISOString().slice(0, 10) },
  });
  assert.equal(lease.status, 201);
  assert.equal(lease.data.side, 'owner');
  assert.equal(lease.data.rent.length, 2, 'one rent row per month from the start');

  const tenantView = await api('GET', '/me/rentals', { token: tenant.token });
  assert.equal(tenantView.data[0].side, 'tenant');
  assert.equal(tenantView.data[0].rent_due, 2);
  const stranger = await api('GET', `/me/rentals/${lease.data.id}`, { token: ctx.casual.token });
  assert.equal(stranger.status, 404);

  assert.equal((await api('POST', `/me/rentals/${lease.data.id}/confirm`, { token: owner.token })).status, 403);
  assert.ok((await api('POST', `/me/rentals/${lease.data.id}/confirm`, { token: tenant.token })).data.tenant_confirmed_at);

  const pay = lease.data.rent[0];
  const reported = await api('POST', `/me/rentals/${lease.data.id}/rent/${pay.id}/report`, {
    token: tenant.token,
    body: { paidOn: new Date().toISOString().slice(0, 10), paymentMode: 'upi', reference: 'UPI-1' },
  });
  assert.equal(reported.data.status, 'reported');
  assert.equal((await api('POST', `/me/rentals/${lease.data.id}/rent/${pay.id}/review`, { token: tenant.token, body: { action: 'confirm' } })).status, 403);
  const confirmed = await api('POST', `/me/rentals/${lease.data.id}/rent/${pay.id}/review`, { token: owner.token, body: { action: 'confirm' } });
  assert.equal(confirmed.data.status, 'confirmed');

  const mr = await api('POST', `/me/rentals/${lease.data.id}/maintenance`, { token: tenant.token, body: { title: 'Kitchen tap leaking', category: 'plumbing', priority: 'high' } });
  assert.equal(mr.status, 201);
  assert.equal((await api('PUT', `/me/rentals/${lease.data.id}/maintenance/${mr.data.id}`, { token: tenant.token, body: { status: 'resolved' } })).status, 403);
  const resolved = await api('PUT', `/me/rentals/${lease.data.id}/maintenance/${mr.data.id}`, { token: owner.token, body: { status: 'resolved', ownerNote: 'Fixed' } });
  assert.equal(resolved.data.status, 'resolved');
  assert.ok(resolved.data.resolved_at);
  const ownerNotes = await pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'rental'`, [owner.id]);
  assert.ok(ownerNotes.rows[0].n >= 3, 'owner notified of confirmation, rent report and maintenance');

  const ended = await api('PUT', `/me/rentals/${lease.data.id}`, { token: owner.token, body: { status: 'ended', endDate: new Date().toISOString().slice(0, 10) } });
  assert.equal(ended.data.status, 'ended');
});

// ------------------------------------------------------- website forms

test('website forms: enquiry message reaches the CRM lead, newsletter, filters, advertiser categories', async () => {
  const A = ctx.admin.token;
  const enquiry = await api('POST', '/leads/public-inquiry', {
    body: { fullName: `Visitor ${RUN}`, mobile: `98${String(Date.now()).slice(-8)}`, message: '[List Property] villa | Noida - call after 6pm', source: 'website' },
  });
  assert.equal(enquiry.status, 201);
  const timeline = await api('GET', `/leads/${enquiry.data.id}/timeline`, { token: A });
  assert.ok(timeline.data.some((t) => t.type === 'note' && t.note.includes('call after 6pm')), 'message shown as a note in the CRM');

  const email = `reader.${RUN}@e2e.test`;
  assert.equal((await api('POST', '/content/newsletter', { body: { email } })).status, 201);
  assert.equal((await api('POST', '/content/newsletter', { body: { email: email.toUpperCase() } })).status, 201, 'repeat is fine');
  assert.equal((await api('POST', '/content/newsletter', { body: { email: 'not-an-email' } })).status, 422);
  const subs = await api('GET', `/content/manage/newsletter?search=${encodeURIComponent(email)}`, { token: A });
  assert.equal(subs.data.items.length, 1);
  assert.equal((await api('GET', '/content/manage/newsletter', { token: ctx.casual.token })).status, 403);
  const unsub = await api('PUT', `/content/manage/newsletter/${subs.data.items[0].id}`, { token: A, body: { status: 'unsubscribed' } });
  assert.ok(unsub.data.unsubscribed_at);

  const multi = await api('GET', '/search/properties?propertyType=apartment,villa&bhk=2,3,5&parking=covered,none&furnishing=Fully%20Furnished,Semi-Furnished');
  assert.equal(multi.status, 200);
  assert.equal((await api('GET', '/search/properties?propertyType=castle')).status, 422);
  assert.equal((await api('GET', '/search/properties?bhk=two')).status, 422);

  const cats = await api('GET', '/bd-leads/advertiser-categories');
  assert.ok(cats.data.some((c) => c.value === 'nbfc'));
  const ad = await api('POST', '/bd-leads', {
    body: { category: 'advertiser', fullName: `Ad ${RUN}`, mobile: `97${String(Date.now()).slice(-8)}`, businessName: 'Loans Co', businessCategory: cats.data[0].value, desiredPlacement: 'Search results' },
  });
  assert.equal(ad.status, 201);
});

// ------------------------------------------------- CRM integration pieces

test('CRM: site visit notifies the customer, property enquiries, customer portal summary, admin metadata', async () => {
  const A = ctx.admin.token;
  const buyer = await createUser('customer', 'visitor');
  const listing = await api('POST', '/properties', {
    token: A,
    body: { title: `2 BHK visit test ${RUN}`, propertyType: 'apartment', transactionType: 'sell', price: '90 Lakh', city: CITY, locality: 'Beta Nagar' },
  });
  assert.equal(listing.status, 201);
  await api('GET', '/me/overview', { token: buyer.token }); // links the account to its customer record, as sign-up does
  await api('POST', '/leads/public-inquiry', { body: { fullName: `visitor ${RUN}`, email: buyer.email, propertyId: listing.data.id, message: 'Visit please' } });

  const inquiries = await api('GET', `/properties/${listing.data.id}/inquiries`, { token: A });
  assert.equal(inquiries.data.length, 1);
  assert.equal(inquiries.data[0].customer_email, buyer.email);
  assert.ok([403, 404].includes((await api('GET', `/properties/${listing.data.id}/inquiries`, { token: buyer.token })).status), 'customers cannot read enquiries');

  await api('PUT', `/leads/${inquiries.data[0].id}/assign`, { token: A, body: { assignedTo: ctx.broker.id } });
  const deal = await api('POST', '/deals', { token: A, body: { leadId: inquiries.data[0].id } });
  assert.equal(deal.status, 201);
  const when = new Date(Date.now() + 2 * 86400000).toISOString();
  const visit = await api('POST', `/deals/${deal.data.id}/site-visit`, { token: A, body: { scheduledAt: when } });
  assert.equal(visit.status, 201);
  await new Promise((r) => setTimeout(r, 200));
  const note = await pool.query(`SELECT title FROM notifications WHERE user_id = $1 AND type = 'site_visit'`, [buyer.id]);
  assert.equal(note.rows[0]?.title, 'Site visit scheduled');
  const visits = await api('GET', '/me/visits', { token: buyer.token });
  assert.equal(visits.data.length, 1, 'customer sees the visit in their dashboard');

  const summary = await api('GET', `/customers/${inquiries.data[0].customer_id}/portal`, { token: A });
  assert.equal(summary.status, 200);
  assert.equal(summary.data.hasAccount, true);
  assert.equal((await api('GET', `/customers/${inquiries.data[0].customer_id}/portal`, { token: buyer.token })).status, 403);

  const meta = await api('GET', '/admin/master', { token: A });
  const cities = meta.data.find((e) => e.name === 'cities');
  assert.equal(cities.fields.find((f) => f.key === 'cityName').column, 'city_name');
});

// -------------------------------------------------------- deal room (M39)

test('deal room: verified buyer + NDA + admin approval gate, append-only access log', async () => {
  const A = ctx.admin.token;
  const investor = await createUser('customer', 'roomer');
  const deal = await pool.query(`SELECT id FROM properties WHERE listing_category = 'auction' AND status = 'approved' ORDER BY created_at DESC LIMIT 1`);
  const P = deal.rows[0].id;

  const before = await api('GET', `/deal-room/${P}`, { token: investor.token });
  assert.equal(before.data.access.open, false);
  assert.equal(before.data.documents.length, 0);
  assert.equal((await api('POST', `/deal-room/${P}/nda`, { token: investor.token, body: { fullName: 'Room Tester', accept: true } })).status, 403, 'unverified cannot sign');

  const profile = await api('PUT', '/investors/me', { token: investor.token, body: { isHni: true } });
  await api('PUT', `/investors/${profile.data.id}/verify`, { token: A, body: { status: 'verified' } });
  assert.equal((await api('POST', `/deal-room/${P}/nda`, { token: investor.token, body: { fullName: 'Room Tester', accept: false } })).status, 400);
  const signed = await api('POST', `/deal-room/${P}/nda`, { token: investor.token, body: { fullName: 'Room Tester', accept: true } });
  assert.equal(signed.data.access.status, 'pending_approval');
  assert.equal(signed.data.access.open, false, 'NDA alone does not open the room');

  const pending = await api('GET', '/deal-room/manage/requests?status=pending_approval', { token: A });
  const request = pending.data.find((r) => r.email === investor.email);
  assert.ok(request);
  assert.equal((await api('PUT', `/deal-room/manage/access/${request.id}`, { token: ctx.sales.token, body: { action: 'approve' } })).status, 403, 'only admins approve');
  assert.equal((await api('PUT', `/deal-room/manage/access/${request.id}`, { token: A, body: { action: 'reject' } })).status, 400, 'reject needs a reason');
  await api('PUT', `/deal-room/manage/access/${request.id}`, { token: A, body: { action: 'approve' } });
  assert.equal((await api('GET', `/deal-room/${P}`, { token: investor.token })).data.access.open, true);

  await api('PUT', `/deal-room/manage/access/${request.id}`, { token: A, body: { action: 'revoke', reason: 'Deal closed' } });
  const after = await api('GET', `/deal-room/${P}`, { token: investor.token });
  assert.equal(after.data.access.open, false);
  assert.equal(after.data.access.decisionReason, 'Deal closed');

  const log = await api('GET', `/deal-room/${P}/access-log`, { token: A });
  assert.ok(['nda_signed', 'access_approved', 'access_revoked'].every((a) => log.data.some((l) => l.action === a)));
  await assert.rejects(pool.query('DELETE FROM deal_room_access_log WHERE property_id = $1', [P]), /append-only/);
  assert.equal((await api('GET', `/deal-room/${P}/access-log`, { token: investor.token })).status, 403);
});

// ---------------------------------------------------- crawler pipeline (§23)

test('crawler: legal approval gate, robots.txt, parse -> queue -> dedupe, legal-review gate on notices', async () => {
  const http = require('http');
  const port = 5000 + Math.floor(Math.random() * 400) + 5300;
  const row = (i) => `<tr class="item"><td class="ref">E2E-${RUN}-${i}</td><td class="t">3 BHK flat ${RUN} ${i}</td><td class="city">${CITY}</td><td class="price">Rs. ${90 + i} Lakh</td><td class="date">2${i}-12-2027</td></tr>`;
  const server = http
    .createServer((req, res) => {
      if (req.url === '/robots.txt') return res.end('User-agent: *\nDisallow: /private\n');
      if (req.url === '/list') return res.end(`<table>${row(1)}${row(2)}</table>`);
      if (req.url === '/notice.txt') return res.end('SALE NOTICE UNDER SARFAESI\nReserve Price: Rs. 1.2 Crore\nEMD: Rs. 12,00,000\nDate of e-Auction: 15-01-2028\nCall 9876543210');
      res.statusCode = 404;
      return res.end();
    })
    .listen(port);
  try {
    const A = ctx.admin.token;
    const sources = await api('GET', '/crawlers/sources', { token: A });
    assert.equal((await api('GET', '/crawlers/sources', { token: ctx.sales.token })).status, 403, 'admins only');
    const src = sources.data.find((s) => s.source_key === 'mstc');
    await api('PUT', `/crawlers/sources/${src.id}/legal-approval`, { token: A, body: { approved: false } }); // clean start on reruns
    await api('POST', `/crawlers/sources/${src.id}/reset`, { token: A });
    assert.equal((await api('PUT', `/crawlers/sources/${src.id}`, { token: A, body: { isEnabled: true } })).status, 400, 'needs legal approval to enable');

    await api('PUT', `/crawlers/sources/${src.id}`, {
      token: A,
      body: {
        listUrl: `http://localhost:${port}/list`,
        adapter: 'html_list',
        config: { itemSelector: 'tr.item', fields: { auction_reference_id: 'td.ref', title: 'td.t', city: 'td.city', reserve_price: 'td.price', auction_date: 'td.date' }, constants: { source_bank: 'MSTC e2e' } },
      },
    });
    const test = await api('POST', `/crawlers/sources/${src.id}/run?mode=test`, { token: A });
    assert.equal(test.data.found, 2);
    assert.equal((await api('POST', `/crawlers/sources/${src.id}/run`, { token: A })).status, 400, 'real run needs legal approval');

    await api('PUT', `/crawlers/sources/${src.id}/legal-approval`, { token: A, body: { approved: true, notes: 'e2e' } });
    const run = await api('POST', `/crawlers/sources/${src.id}/run`, { token: A });
    assert.equal(run.data.summary.received, 2);
    const again = await api('POST', `/crawlers/sources/${src.id}/run`, { token: A });
    assert.equal(again.data.summary.skipped_existing, 2, 'already-seen records are skipped');

    await api('PUT', `/crawlers/sources/${src.id}`, { token: A, body: { listUrl: `http://localhost:${port}/private/list` } });
    const blocked = await api('POST', `/crawlers/sources/${src.id}/run`, { token: A });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.message, /robots\.txt/);

    // Notice parsed from text, held for legal review.
    const fd = new FormData();
    fd.append('file', new Blob(['SALE NOTICE UNDER SARFAESI\nFlat in ' + CITY + '\nReserve Price: Rs. 1.2 Crore\nEMD: Rs. 12,00,000\nDate of e-Auction: 15-01-2028\nCall 9876543210'], { type: 'text/plain' }), 'notice.txt');
    fd.append('legalReview', 'true');
    fd.append('sourceName', `E2E notice ${RUN}`);
    const parsed = await fetch(`${BASE}/crawlers/parse-notice`, { method: 'POST', headers: { authorization: `Bearer ${A}` }, body: fd }).then((r) => r.json());
    assert.equal(parsed.data.parsed.reserve_price, 12000000);
    assert.equal(parsed.data.parsed.emd_amount, 1200000);
    const itemId = parsed.data.summary.items[0].id;
    const item = await api('GET', `/opportunities/ingest/${itemId}`, { token: A });
    assert.equal(item.data.requires_legal_review, true);
    assert.ok(!JSON.stringify(item.data.normalised).includes('9876543210'), 'contact numbers never stored');
    const early = await api('POST', `/opportunities/ingest/${itemId}/publish`, { token: A, body: { normalised: { title: `Notice flat ${RUN}`, property_type: 'apartment', city: CITY } } });
    assert.equal(early.status, 400);
    assert.match(early.body.message, /legal review/);
    await api('POST', `/opportunities/ingest/${itemId}/legal-review`, { token: A, body: { notes: 'panel ok' } });
    const published = await api('POST', `/opportunities/ingest/${itemId}/publish`, { token: A, body: { normalised: { title: `Notice flat ${RUN}`, property_type: 'apartment', city: CITY } } });
    assert.equal(published.status, 201);

    const health = await api('GET', '/crawlers/health', { token: A });
    assert.ok(health.data.approved >= 1);
    await api('PUT', `/crawlers/sources/${src.id}/legal-approval`, { token: A, body: { approved: false } });
  } finally {
    server.close();
  }
});

// ------------------------------------ IRM, AI matching, deal advisory (Engine 3, Module 38)

test('IRM: deal advisory, AI investor-deal matching both ways, tiers, curated ranking, rescore', async () => {
  const A = ctx.admin.token;
  const investor = await createUser('customer', 'irm');
  const deal = (await pool.query(`SELECT id, city, listing_category FROM properties WHERE listing_category = 'auction' AND status = 'approved' ORDER BY created_at DESC LIMIT 1`)).rows[0];
  const profile = await api('PUT', '/investors/me', {
    token: investor.token,
    body: { isHni: true, preferredCities: [deal.city], assetClassPreferences: ['auction'] },
  });
  await api('PUT', `/investors/${profile.data.id}/verify`, { token: A, body: { status: 'verified' } });

  const detail = await api('GET', `/opportunities/${deal.id}`, { token: investor.token });
  assert.ok(['value', 'balanced', 'higher_risk'].includes(detail.data.advisory.profile));
  assert.ok(detail.data.advisory.structure.length > 0 && detail.data.advisory.checks.length > 0);
  assert.ok(detail.data.my_match.score > 0 && detail.data.my_match.reasons.length > 0);
  const teaser = await api('GET', `/opportunities/${deal.id}`);
  assert.equal(teaser.data.advisory, undefined, 'advisory is for full-access users only');

  const curated = await api('GET', '/hni/deals', { token: investor.token });
  const scores = curated.data.items.map((d) => d.match_score);
  assert.ok(scores.length > 0 && scores.every((s) => typeof s === 'number'));
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'curated deals ranked by match');

  const matched = await api('GET', `/opportunities/${deal.id}/matched-investors`, { token: ctx.sales.token });
  assert.ok(matched.data.some((m) => m.investorProfileId === profile.data.id));
  assert.equal((await api('GET', `/opportunities/${deal.id}/matched-investors`, { token: investor.token })).status, 403);

  const irm = await api('GET', `/investors/${profile.data.id}/irm`, { token: ctx.sales.token });
  assert.ok(['new', 'engaged', 'repeat', 'vip'].includes(irm.data.tier));
  assert.ok(Array.isArray(irm.data.aiMatches));
  const segments = await api('GET', '/investors/irm/segments', { token: ctx.sales.token });
  assert.ok(segments.data.total >= 1 && segments.data.byTier);

  assert.equal((await api('POST', '/opportunities/rescore-all', { token: ctx.sales.token })).status, 403);
  const rescored = await api('POST', '/opportunities/rescore-all', { token: A });
  assert.ok(rescored.data.rescored >= 1);
});

// ------------------------------------------- NRI / HNI onboarding (Screen 2), sec. 33 exemptions

test('investor onboarding: RM introduced, HN code, HNI full CRM, investor-only onboarding, seller special situation', async () => {
  const hni = await createUser('customer', 'onbhni');
  const created = await api('PUT', '/investors/me', {
    token: hni.token,
    body: { isHni: true, countryOfResidence: 'India', propertyInterestTypes: ['invest', 'buy'] },
  });
  assert.equal(created.status, 200);
  assert.deepEqual(created.data.property_interest_types, ['invest', 'buy']);
  assert.ok(created.data.assigned_manager_id, 'relationship manager auto-assigned');
  const notes = await pool.query(`SELECT type FROM notifications WHERE user_id = $1`, [hni.id]);
  assert.ok(notes.rows.some((n) => n.type === 'investor_manager_assigned'));

  const onboard = await api('PUT', '/me/profile', { token: hni.token, body: { portalRoles: [] } });
  assert.equal(onboard.status, 200, 'investor can onboard without a buyer/seller role');
  assert.ok(onboard.data.onboardedAt);
  assert.equal(onboard.data.tier.current, 'full', 'HNI gets Full CRM from joining');
  assert.equal(onboard.data.tier.exempt, true);
  assert.match(onboard.data.referral.code, /^HN-/);
  assert.equal(onboard.data.investor.isHni, true);

  const plain = await createUser('customer', 'onbplain');
  assert.equal((await api('PUT', '/me/profile', { token: plain.token, body: { portalRoles: [] } })).status, 400);

  const listing = await api('POST', '/me/listings', {
    token: plain.token,
    body: {
      title: `Urgent sale 3 BHK ${RUN}`, propertyType: 'apartment', transactionType: 'sell', price: '9000000',
      city: CITY, locality: 'Sector 1', consentToken: await consent(plain.token), situationTags: ['urgent_sale', 'investor_exit'], estimatedMarketValue: 11000000,
    },
  });
  assert.equal(listing.status, 201);
  const row = (await pool.query('SELECT listing_category, opportunity_source_type, situation_tags, discount_percent FROM properties WHERE id = $1', [listing.data.id])).rows[0];
  assert.equal(row.listing_category, 'special_situation');
  assert.equal(row.opportunity_source_type, 'direct_seller');
  assert.deepEqual(row.situation_tags, ['urgent_sale', 'investor_exit']);
  assert.ok(Number(row.discount_percent) > 0);
  assert.equal((await api('POST', '/me/listings', { token: plain.token, body: { title: 'Bad tag listing', propertyType: 'apartment', transactionType: 'sell', price: '100', city: CITY, locality: 'X', consentToken: await consent(plain.token), situationTags: ['distressed'] } })).status, 422);
});

// ------------------------------------------- Investor CRM workspace (sec. 13.2 / 13.2A)

test('investor workspace: HNI gets Full CRM, lite customer locked, pipeline with SLA, activity, permanent upgrade', async () => {
  const hni = await createUser('customer', 'wshni');
  const profile = await api('PUT', '/investors/me', { token: hni.token, body: { isHni: true } });
  await api('PUT', `/investors/${profile.data.id}/verify`, { token: ctx.admin.token, body: { status: 'verified' } });

  const access = await api('GET', '/workspace/access', { token: hni.token });
  assert.equal(access.data.eligible, true);
  assert.equal(access.data.tier.exempt, true);
  assert.ok(access.data.tier.fullSince);

  const lite = await createUser('customer', 'wslite');
  assert.equal((await api('GET', '/workspace/access', { token: lite.token })).data.eligible, false);
  assert.equal((await api('GET', '/workspace/summary', { token: lite.token })).status, 403);
  assert.equal((await api('GET', '/workspace/access', { token: ctx.sales.token })).data.eligible, false, 'staff use the main CRM');

  const deal = (await pool.query(`SELECT id FROM properties WHERE listing_category = 'auction' AND status = 'approved' ORDER BY created_at DESC LIMIT 1`)).rows[0];
  const interest = await api('POST', `/opportunities/${deal.id}/interest`, { token: hni.token, body: { intendedBidAmount: 12000000 } });
  assert.ok([200, 201].includes(interest.status));
  await api('PUT', `/opportunities/interests/${interest.data.id}/stage`, { token: ctx.admin.token, body: { stage: 'deal_interest', notes: 'Called investor' } });

  const pipeline = await api('GET', '/workspace/pipeline', { token: hni.token });
  const col = pipeline.data.columns.find((c) => c.stage === 'deal_interest');
  const card = col.items.find((i) => i.id === interest.data.id);
  assert.ok(card, 'deal is in the Deal Interest column');
  assert.equal(card.sla.status, 'on_track');
  assert.equal(card.sla.limitDays, 5);
  assert.ok(card.history.some((h) => h.to_stage === 'deal_interest'));

  const activity = await api('GET', '/workspace/activity', { token: hni.token });
  assert.ok(activity.data.some((a) => a.kind === 'stage_change' && a.detail === 'lead>deal_interest'));
  assert.ok(activity.data.some((a) => a.kind === 'deal_action' && a.detail === 'interest_expressed'));

  const summary = await api('GET', '/workspace/summary', { token: hni.token });
  assert.equal(summary.data.pipeline.byStage.deal_interest.count, 1);
  assert.equal(summary.data.pipeline.active, 1);

  // Downgrade never applies (sec. 13.2A).
  await api('PUT', '/investors/me', { token: hni.token, body: { isHni: false, isNri: true } });
  assert.equal((await api('GET', '/workspace/access', { token: hni.token })).data.eligible, true);
});

// ------------------------------------------ Matching engine + Requirement Marketplace (sec. 7, Engine 5)

test('matching engine: binding weights, tiers, reverse matching, marketplace, send/share, digest, expiry, learning, A/B', async () => {
  const A = ctx.admin.token;
  const B = ctx.broker.token;
  const MCITY = `Match City ${RUN}`;
  const mk = async (over) => {
    const r = await api('POST', '/properties', {
      token: B,
      body: { ...baseListing(), city: MCITY, locality: 'Beta Nagar', latitude: undefined, longitude: undefined, amenities: ['Gym', 'Pool'], ...over },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await api('PUT', `/properties/${r.data.id}/approve`, { token: A })).status, 200);
    return r.data.id;
  };
  const hotId = await mk({ title: `Hot flat ${RUN}`, price: '1 Cr', areaSqft: 1500 });
  // villa ~ apartment? no - villa is "similar" only to houses; use independent_house requirement below.
  const warmId = await mk({ title: `Warm villa ${RUN}`, propertyType: 'villa', price: '1.38 Cr', areaSqft: 1500 });
  const lukeId = await mk({ title: `Luke plot ${RUN}`, propertyType: 'plot', price: '1.38 Cr', areaSqft: 1500, amenities: ['Gym'] });
  await new Promise((r) => setTimeout(r, 400));

  const buyer = await createUser('customer', 'matchbuyer');
  const req = await api('POST', '/me/requirements', {
    token: buyer.token,
    body: {
      purpose: 'buy', propertyType: 'independent_house', city: MCITY, budgetMin: 8000000, budgetMax: 12000000,
      areaMinSqft: 1200, areaMaxSqft: 1800, amenities: ['gym', 'pool'], urgency: 'immediate', consentToken: await consent(buyer.token, 'requirement'),
    },
  });
  assert.equal(req.status, 201);
  assert.ok(new Date(req.data.expires_at) > new Date(Date.now() + 59 * 86400000), '60-day validity');
  // The hot listing is an apartment - make it the requested type so it is an exact 100.
  await pool.query(`UPDATE properties SET property_type = 'independent_house' WHERE id = $1`, [hotId]);
  await api('PUT', `/me/requirements/${req.data.id}`, { token: buyer.token, body: { urgency: 'immediate' } });
  await new Promise((r) => setTimeout(r, 800));

  const matches = await api('GET', '/me/matches', { token: buyer.token });
  const byId = Object.fromEntries(matches.data.items.map((m) => [m.property.id, m]));
  assert.equal(byId[hotId].score, 100);
  assert.equal(byId[hotId].tier, 'hot');
  assert.equal(byId[hotId].breakdown.location.weight, 30);
  assert.equal(byId[hotId].breakdown.budget.weight, 25);
  // villa: similar type 70%, 15% over budget -> 50%: 30 + 12.5 + 14 + 15 + 10 = 81.5
  assert.equal(byId[warmId].tier, 'warm');
  assert.equal(byId[warmId].breakdown.type.score, 70);
  assert.equal(byId[warmId].breakdown.budget.score, 50);
  assert.equal(byId[lukeId], undefined, 'Lukewarm is not shown unless sent');
  assert.equal(matches.data.thresholds.hot, 90);

  const buyerAlert = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'match_alert' AND related_entity_id = $2`, [buyer.id, hotId]);
  assert.equal(buyerAlert.rows.length, 1, 'buyer gets one instant Hot alert');
  const brokerAlert = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'match_alert_broker' AND related_entity_id = $2`, [ctx.broker.id, req.data.id]);
  assert.equal(brokerAlert.rows.length, 1, 'reverse matching: listing broker alerted once');

  // Marketplace - masked, best match vs the broker's listings.
  const market = await api('GET', `/matching/marketplace?city=${encodeURIComponent(MCITY)}`, { token: B });
  const row = market.data.find((r) => r.id === req.data.id);
  assert.ok(row && row.hot && row.bestMatchWithMyListings.score === 100);
  assert.equal(row.customer_id, undefined);
  assert.equal((await api('GET', '/matching/marketplace', { token: buyer.token })).status, 403);

  // Broker sends the Lukewarm plot; below-threshold listing refused.
  const sent = await api('POST', `/matching/requirements/${req.data.id}/send`, { token: B, body: { propertyId: lukeId } });
  assert.equal(sent.data.tier, 'lukewarm');
  const farId = await mk({ title: `Far plot ${RUN}`, propertyType: 'plot', city: `Elsewhere ${RUN}`, price: '9 Cr', amenities: [] });
  assert.equal((await api('POST', `/matching/requirements/${req.data.id}/send`, { token: B, body: { propertyId: farId } })).status, 400);
  const after = await api('GET', '/me/matches', { token: buyer.token });
  assert.ok(after.data.items.find((m) => m.property.id === lukeId)?.sentByRepresentative);

  // Lead view + matched buyers for a listing.
  const leadMatches = await api('GET', `/matching/leads/${req.data.lead_id}`, { token: B });
  assert.equal(leadMatches.data.items[0].property.id, hotId);
  const buyers = await api('GET', `/matching/listings/${hotId}/buyers`, { token: B });
  assert.ok(buyers.data.some((b) => b.requirement.id === req.data.id && b.priceCompatible === undefined), 'price-compatible flag hidden from brokers');
  assert.ok((await api('GET', `/matching/listings/${hotId}/buyers`, { token: A })).data.some((b) => b.priceCompatible === false));

  // Mandate-verification routing.
  const partner = await createUser('broker', 'partner');
  const share = await api('POST', `/matching/requirements/${req.data.id}/share`, { token: B, body: { brokerId: partner.id } });
  assert.equal(share.data.status, 'pending');
  assert.equal((await api('PUT', `/matching/shares/${share.data.id}`, { token: partner.token, body: { action: 'accept' } })).data.status, 'accepted');
  const shared = await api('GET', '/matching/marketplace?sharedOnly=true', { token: partner.token });
  assert.ok(shared.data.some((r) => r.id === req.data.id && r.sharedWithMe === 'accepted'));

  // Card badges + click event.
  const scores = await api('GET', `/me/match-scores?ids=${hotId},${warmId}`, { token: buyer.token });
  assert.equal(scores.data[hotId].score, 100);
  assert.equal((await api('POST', '/me/match-events', { token: buyer.token, body: { propertyId: hotId, event: 'clicked' } })).data.recorded, 1);

  // Daily Warm digest.
  await api('POST', '/matching/jobs/digest', { token: A });
  const digest = await pool.query(`SELECT message FROM notifications WHERE user_id = $1 AND type = 'match_digest'`, [buyer.id]);
  assert.ok(digest.rows.length === 1 && digest.rows[0].message.includes('Warm villa'));

  // Expiry: warning, then expiry (paused, non-sent matches dropped), then renewal.
  await pool.query(`UPDATE requirements SET expires_at = now() + interval '1 day' WHERE id = $1`, [req.data.id]);
  await api('POST', '/matching/jobs/expiry', { token: A });
  assert.equal((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'requirement_expiring'`, [buyer.id])).rows.length, 1);
  await pool.query(`UPDATE requirements SET expires_at = now() - interval '1 minute' WHERE id = $1`, [req.data.id]);
  await api('POST', '/matching/jobs/expiry', { token: A });
  const expired = (await pool.query('SELECT status, expired_at FROM requirements WHERE id = $1', [req.data.id])).rows[0];
  assert.equal(expired.status, 'paused');
  assert.ok(expired.expired_at);
  const left = await pool.query('SELECT property_id FROM requirement_matches WHERE requirement_id = $1', [req.data.id]);
  assert.deepEqual(left.rows.map((r) => r.property_id), [lukeId], 'only the broker-sent match survives expiry');
  const renewed = await api('POST', `/me/requirements/${req.data.id}/renew`, { token: buyer.token });
  assert.equal(renewed.data.status, 'active');
  assert.equal(renewed.data.renewal_count, 1);

  // AI learning: not enough data -> no change; with data -> bounded, normalised weights.
  const before = await api('POST', '/matching/jobs/learn', { token: A });
  if (!before.data.learned) assert.match(before.data.reason, /Need/);
  const bd = (loc, bud) => JSON.stringify({ location: { score: loc }, budget: { score: bud }, type: { score: 100 }, area: { score: 100 }, amenities: { score: 100 } });
  for (let i = 0; i < 60; i += 1) {
    await pool.query(`INSERT INTO match_events (requirement_id, property_id, event, variant, breakdown, event_date) VALUES ($1, $2, 'shown', 'A', $3, CURRENT_DATE - $4::int)`, [req.data.id, hotId, bd(50, 100), i + 1]);
    await pool.query(`INSERT INTO match_events (requirement_id, property_id, event, variant, breakdown) VALUES ($1, $2, 'enquired', 'A', $3)`, [req.data.id, hotId, bd(100, 100)]);
  }
  const learned = await api('POST', '/matching/jobs/learn', { token: A });
  assert.equal(learned.data.learned, true);
  const w = learned.data.weights;
  assert.ok(Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 100) < 0.5, 'weights sum to 100');
  assert.ok(w.location > 30 && w.location <= 30 * 1.3 + 3, 'location gains weight, within the bound');
  const overview = await api('GET', '/matching/overview', { token: A });
  assert.ok(overview.data.learned);
  const ab = await api('GET', '/matching/ab-report', { token: A });
  assert.ok(ab.data.variants.A.shown >= 60 && ab.data.variants.B);
  // Leave the engine on its binding weights for other tests / runs.
  await pool.query(`UPDATE app_config SET value = 'null' WHERE config_key = 'matching.learned_weights'`);
  await pool.query(`UPDATE app_config SET value = '{}' WHERE config_key = 'matching.pattern_boosts'`);
  await pool.query('DELETE FROM match_events WHERE requirement_id = $1', [req.data.id]);
});

// ------------------------------------------------ Trust & Reputation (sec. 8, Engine 5)

test('trust: verifications, score components, badges + warning/revocation, reviews with fraud filter, mandate bonus, awards', async () => {
  const A = ctx.admin.token;
  const S = ctx.sales.token;
  const broker = await createUser('broker', 'trustbroker');
  const TCITY = `Trust City ${RUN}`;

  const fresh = await api('GET', '/trust/me', { token: broker.token });
  assert.deepEqual(fresh.data.weights, { verification: 20, deals: 30, response: 20, ratings: 25, geo: 5 });
  assert.ok(fresh.data.nextSteps.some((s) => /KYC/.test(s)));

  // Verifications.
  assert.equal((await api('POST', '/trust/verifications', { token: broker.token, body: { kind: 'gst', reference: 'NOTAGST' } })).status, 400);
  const kyc = await api('POST', '/trust/verifications', { token: broker.token, body: { kind: 'kyc', reference: 'ABCDE1234F' } });
  assert.equal(kyc.status, 201);
  assert.equal(kyc.data.reference, '••••234F', 'only the last 4 characters of an ID are stored');
  const rera = await api('POST', '/trust/verifications', { token: broker.token, body: { kind: 'rera', reference: `RERA-${RUN}` } });
  const gst = await api('POST', '/trust/verifications', { token: broker.token, body: { kind: 'gst', reference: '29abcde1234f1z5' } });
  assert.equal(gst.data.reference, '29ABCDE1234F1Z5');
  assert.equal((await api('PUT', `/trust/verifications/${kyc.data.id}`, { token: broker.token, body: { action: 'verify' } })).status, 403);
  assert.equal((await api('PUT', `/trust/verifications/${kyc.data.id}`, { token: S, body: { action: 'reject' } })).status, 400, 'reason required');
  for (const v of [kyc, rera, gst]) await api('PUT', `/trust/verifications/${v.data.id}`, { token: S, body: { action: 'verify' } });
  await pool.query(`UPDATE users SET mobile_verified = true, profile_picture_url = 'x.jpg' WHERE id = $1`, [broker.id]);

  // Two closed deals + a live geo-located listing in a region.
  const custUser = await createUser('customer', 'trustbuyer');
  await api('GET', '/me/profile', { token: custUser.token });
  const cust = (await pool.query('SELECT id FROM customers WHERE user_id = $1', [custUser.id])).rows[0].id;
  const listing = await api('POST', '/properties', { token: broker.token, body: { ...baseListing(), title: `Trust flat ${RUN}`, city: TCITY } });
  await api('PUT', `/properties/${listing.data.id}/approve`, { token: A });
  const lastQuarter = new Date(new Date().getFullYear(), Math.floor(new Date().getMonth() / 3) * 3 - 1, 15);
  const d1 = (await pool.query(`INSERT INTO deals (customer_id, broker_id, property_id, stage, deal_value, closed_at) VALUES ($1, $2, $3, 'closed_won', 20000000, $4) RETURNING id`, [cust, broker.id, listing.data.id, lastQuarter])).rows[0].id;
  await pool.query(`INSERT INTO deals (customer_id, broker_id, stage, deal_value, closed_at) VALUES ($1, $2, 'closed_won', 9000000, $3)`, [cust, broker.id, lastQuarter]);

  const t = await api('GET', '/trust/me?refresh=true', { token: broker.token });
  assert.equal(t.data.components.verification.score, 100);
  assert.equal(t.data.components.geo.score, 100);
  assert.equal(t.data.inputs.deals, 2);
  const keys = t.data.badges.map((b) => b.badge_key);
  assert.ok(keys.includes('verified_user') && keys.includes('verified_broker'), JSON.stringify(keys));
  const earned = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'trust_badge' AND title LIKE '%Verified Broker%'`, [broker.id]);
  assert.equal(earned.rows.length, 1);

  // Reviews: only after a verified interaction; contact details blocked.
  const stranger = await createUser('customer', 'trustnobody');
  assert.equal((await api('POST', '/trust/reviews', { token: stranger.token, body: { dealId: d1, subject: 'broker', rating: 5 } })).status, 403);
  const eligible = await api('GET', '/trust/reviews/eligible', { token: custUser.token });
  const item = eligible.data.find((e) => e.dealId === d1 && e.subject === 'broker');
  assert.ok(item && !item.userId, 'subject identity not exposed');
  assert.equal((await api('POST', '/trust/reviews', { token: custUser.token, body: { dealId: d1, subject: 'broker', rating: 5, body: 'Call me on 9876543210' } })).status, 422);
  const text = `Very smooth purchase, the representative handled paperwork and negotiation well ${RUN}`;
  const review = await api('POST', '/trust/reviews', { token: custUser.token, body: { dealId: d1, subject: 'broker', rating: 5, title: 'Great', body: text } });
  assert.equal(review.status, 201);
  assert.equal(review.data.status, 'published');
  assert.equal((await api('POST', '/trust/reviews', { token: custUser.token, body: { dealId: d1, subject: 'broker', rating: 4 } })).status, 400, 'one review per interaction');

  // Copy-paste review from a brand-new account -> moderation.
  const cust2User = await createUser('customer', 'trustcopy');
  await api('GET', '/me/profile', { token: cust2User.token });
  const cust2 = (await pool.query('SELECT id FROM customers WHERE user_id = $1', [cust2User.id])).rows[0].id;
  const d3 = (await pool.query(`INSERT INTO deals (customer_id, broker_id, stage, closed_at) VALUES ($1, $2, 'closed_won', now()) RETURNING id`, [cust2, broker.id])).rows[0].id;
  const copied = await api('POST', '/trust/reviews', { token: cust2User.token, body: { dealId: d3, subject: 'broker', rating: 5, body: text } });
  assert.equal(copied.data.status, 'pending_moderation');
  const queue = await api('GET', '/trust/reviews/moderation', { token: S });
  const q = queue.data.find((r) => r.id === copied.data.id);
  assert.ok(q.fraudScore >= 40 && q.fraudReasons.some((r) => /Same text/.test(r)));
  assert.equal((await api('PUT', `/trust/reviews/${copied.data.id}/moderate`, { token: S, body: { action: 'reject' } })).status, 403, 'admins moderate');
  await api('PUT', `/trust/reviews/${copied.data.id}/moderate`, { token: A, body: { action: 'reject', note: 'Duplicate text' } });

  // Reply once; report goes to the queue.
  assert.equal((await api('POST', `/trust/reviews/${review.data.id}/reply`, { token: broker.token, body: { reply: 'Thank you!' } })).data.reply, 'Thank you!');
  assert.equal((await api('POST', `/trust/reviews/${review.data.id}/reply`, { token: broker.token, body: { reply: 'Again' } })).status, 404);
  await api('POST', `/trust/reviews/${review.data.id}/report`, { token: broker.token, body: { reason: 'testing the report flow' } });
  assert.ok((await api('GET', '/trust/reviews/moderation', { token: S })).data.some((r) => r.id === review.data.id));
  await api('PUT', `/trust/reviews/${review.data.id}/moderate`, { token: A, body: { action: 'approve' } });

  const withReview = await api('GET', '/trust/me?refresh=true', { token: broker.token });
  assert.equal(withReview.data.inputs.reviews, 1);
  assert.ok(withReview.data.components.ratings.score > 62, 'a 5-star review lifts the Bayesian rating');

  // Public trust card - no identity.
  const card = await api('GET', `/trust/public/listings/${listing.data.id}`);
  assert.equal(card.data.listerType, 'broker');
  assert.ok(card.data.badges.some((b) => b.key === 'verified_broker'));
  assert.equal(card.data.reviews[0].reply, 'Thank you!');
  assert.equal(JSON.stringify(card.data).includes(broker.email), false);
  const search = await api('GET', `/search/properties?city=${encodeURIComponent(TCITY)}`);
  assert.ok(search.data.items[0].lister_trust.badges.includes('verified_broker'));

  // Exclusive Mandate: badge + one-time +5 bonus; badge goes at once when the mandate ends, bonus stays.
  // (mandate activation sets the listing's mandate_type - see the Module 46 test)
  await pool.query(`UPDATE properties SET mandate_type = 'exclusive' WHERE id = $1`, [listing.data.id]);
  const mandated = await api('GET', '/trust/me?refresh=true', { token: broker.token });
  assert.ok(mandated.data.badges.some((b) => b.badge_key === 'exclusive_mandate'));
  assert.equal(mandated.data.inputs.mandateBonus, 5);
  await pool.query(`UPDATE properties SET mandate_type = 'standard' WHERE id = $1`, [listing.data.id]);
  const ended = await api('GET', '/trust/me?refresh=true', { token: broker.token });
  assert.ok(!ended.data.badges.some((b) => b.badge_key === 'exclusive_mandate'));
  assert.equal(ended.data.inputs.mandateBonus, 5);

  // Criteria lapse -> warning -> revoked after 7 days.
  await api('PUT', `/trust/verifications/${rera.data.id}`, { token: S, body: { action: 'reject', notes: 'Registration expired' } });
  const warned = await api('GET', '/trust/me?refresh=true', { token: broker.token });
  assert.equal(warned.data.badges.find((b) => b.badge_key === 'verified_broker').status, 'warning');
  await pool.query(`UPDATE user_badges SET warning_at = now() - interval '8 days' WHERE user_id = $1 AND badge_key = 'verified_broker'`, [broker.id]);
  const revoked = await api('GET', '/trust/me?refresh=true', { token: broker.token });
  assert.ok(!revoked.data.badges.some((b) => b.badge_key === 'verified_broker'));

  // Best Broker for last quarter in the broker's region + shareable image.
  const best = await api('POST', '/trust/jobs/best_quarter', { token: A });
  assert.ok(best.data.awarded >= 1);
  const trophy = (await pool.query(`SELECT id, region, meta FROM user_badges WHERE user_id = $1 AND badge_key = 'best_broker'`, [broker.id])).rows[0];
  assert.equal(trophy.region, TCITY);
  assert.equal(trophy.meta.deals, 2);
  const img = await fetch(`${BASE}/trust/badges/${trophy.id}/image.svg`);
  assert.equal(img.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.match(await img.text(), /Best Broker/);
  assert.equal((await api('POST', '/trust/jobs/featured', { token: A })).status, 200);

  const board = await api('GET', `/trust/leaderboard?region=${encodeURIComponent(TCITY)}`, { token: S });
  assert.equal(board.data[0].user_id, broker.id);
});

// ------------------------------------ Verification, duplicates & fraud scoring (sec. 9, Module 19)

test('fraud: L1-L4 verification, 4-layer duplicates + resolution/routing, risk bands + actions, appeal, suspension, image scan', async () => {
  const A = ctx.admin.token;
  const S = ctx.sales.token;
  const FCITY = `Fraud City ${RUN}`;
  const mk = (over) => ({
    title: `Sunny flat ${RUN} ${Math.random().toString(36).slice(2, 7)}`,
    description: `Well kept home near the park, ${Math.random().toString(36).slice(2)} ${Math.random().toString(36).slice(2)} good light and ventilation`,
    propertyType: 'apartment', transactionType: 'sell', price: '60 Lakh', city: FCITY, locality: 'Gamma Nagar',
    address: `Tower ${Math.floor(Math.random() * 900)}, Street ${Math.floor(Math.random() * 900)}`,
    latitude: 17.5 + Math.random() / 10, longitude: 78.4 + Math.random() / 10, areaSqft: 1200, bedrooms: 2, ...over,
  });
  const brokerA = await createUser('broker', 'fraudA');
  const brokerB = await createUser('broker', 'fraudB');
  const brokerC = await createUser('broker', 'fraudC');
  await pool.query(`UPDATE users SET mobile_verified = true WHERE id = ANY($1::uuid[])`, [[brokerA.id, brokerB.id]]);

  // Green -> live instantly; L1 needs 3 images.
  const green = await api('POST', '/properties', { token: brokerA.token, body: mk({ title: `Green home ${RUN}`, address: `Plot 12, Sector 9, ${RUN}`, latitude: 17.44, longitude: 78.35, bedrooms: 3 }) });
  assert.equal(green.status, 201, JSON.stringify(green.body));
  assert.equal(green.data.status, 'approved');
  assert.equal(green.data.fraud_band, 'green');
  assert.equal(green.data.verification_level, 0, 'L1 needs 3 photos');
  for (let i = 0; i < 3; i += 1) {
    // Random 64-bit fingerprints - unrelated to any other listing's photos.
    const fp = BigInt.asIntN(64, BigInt(`0x${crypto.randomBytes(8).toString('hex')}`)).toString();
    await pool.query(`INSERT INTO property_media (property_id, url, phash, scan_status) VALUES ($1, $2, $3, 'clean')`, [green.data.id, `https://img.example/${RUN}-${i}.jpg`, fp]);
  }
  const l1 = await api('POST', `/fraud/listings/${green.data.id}/assess`, { token: S });
  assert.equal(l1.data.verificationLevel, 1);
  assert.ok(Object.values(l1.data.systemChecks).every(Boolean));

  // Duplicate, same lister, same address -> blocked; update existing merges + closes it.
  const dupSame = await api('POST', '/properties', { token: brokerA.token, body: mk({ title: `Green home again ${RUN}`, address: `Plot 12, Sector 9, ${RUN}`, latitude: 17.44001, longitude: 78.35001, bedrooms: 3, price: '58 Lakh' }) });
  assert.equal(dupSame.data.status, 'pending_approval');
  assert.equal(dupSame.data.duplicate_status, 'blocked');
  assert.equal(dupSame.data.duplicate_of, green.data.id, 'first valid timestamp wins');
  assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'duplicate_listing'`, [brokerA.id])).rows.length);
  const merged = await api('POST', `/fraud/listings/${dupSame.data.id}/duplicate-resolution`, { token: brokerA.token, body: { action: 'update_existing' } });
  assert.equal(merged.data.merged, true);
  const orig = (await pool.query('SELECT status, price_value FROM properties WHERE id = $1', [green.data.id])).rows[0];
  assert.equal(orig.status, 'approved');
  assert.equal(Number(orig.price_value), 5800000, 'newer info merged into the original');

  // Different lister, identical text -> blocked; routing request -> accepted -> partners 50/50.
  const g = (await pool.query('SELECT title, description FROM properties WHERE id = $1', [green.data.id])).rows[0];
  const copy = await api('POST', '/properties', { token: brokerB.token, body: mk({ title: g.title, description: g.description, city: FCITY }) });
  assert.equal(copy.data.duplicate_status, 'blocked');
  assert.equal((await api('POST', `/fraud/listings/${copy.data.id}/duplicate-resolution`, { token: brokerA.token, body: { action: 'cancel' } })).status, 403, 'only the lister resolves');
  await api('POST', `/fraud/listings/${copy.data.id}/duplicate-resolution`, { token: brokerB.token, body: { action: 'request_routing', note: 'I also hold this mandate' } });
  const routing = await api('GET', '/fraud/routing', { token: brokerA.token });
  const rr = routing.data.find((r) => r.property_id === copy.data.id);
  assert.equal((await api('PUT', `/fraud/routing/${rr.id}`, { token: brokerB.token, body: { action: 'accept' } })).status, 403);
  await api('PUT', `/fraud/routing/${rr.id}`, { token: brokerA.token, body: { action: 'accept' } });
  const partners = await pool.query('SELECT partner_user_id, split_percent FROM property_partners WHERE property_id = $1 ORDER BY split_percent', [green.data.id]);
  assert.equal(partners.rows.length, 2);
  assert.equal((await pool.query('SELECT status FROM properties WHERE id = $1', [copy.data.id])).rows[0].status, 'inactive');

  // Different lister, same spot + similar price, different text -> flagged, live under review.
  const flagged = await api('POST', '/properties', { token: brokerB.token, body: mk({ address: `Plot 12, Sector 9, ${RUN}`, latitude: 17.44002, longitude: 78.35002, bedrooms: 3, price: '59 Lakh' }) });
  assert.equal(flagged.data.status, 'approved');
  assert.equal(flagged.data.duplicate_status, 'flagged');
  assert.equal(flagged.data.under_review, true);
  assert.ok(flagged.data.fraud_factors.some((f) => f.key === 'behaviour_anomaly'));

  // Red: suspicious payment (+40) + unverified mobile (+10) -> held + lister told.
  const red = await api('POST', '/properties', { token: brokerC.token, body: mk({ description: `Nice home. Pay advance via crypto to reserve ${RUN} today only` }) });
  assert.equal(red.data.fraud_band, 'red');
  assert.equal(red.data.status, 'pending_approval');
  assert.ok(red.data.fraud_factors.some((f) => f.key === 'suspicious_payment'));
  assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'listing_held'`, [brokerC.id])).rows.length);
  const queue = await api('GET', '/fraud/queue', { token: S });
  // On a long-lived dev database the queue (oldest 200 first) can be full of earlier runs' items.
  const heldRow = (await pool.query('SELECT review_due_at FROM properties WHERE id = $1', [red.data.id])).rows[0];
  assert.ok(heldRow.review_due_at, 'held listing gets a review deadline');
  assert.ok(
    queue.data.listings.some((l) => l.id === red.data.id && l.review_due_at) ||
      (queue.data.listings.length === 200 && new Date(queue.data.listings[199].review_due_at) <= new Date(heldRow.review_due_at))
  );
  assert.equal((await api('GET', '/fraud/queue', { token: brokerA.token })).status, 403);
  const lister = await api('GET', `/fraud/listings/${red.data.id}`, { token: brokerC.token });
  assert.equal(lister.data.fraud.score, undefined, 'score + factors are staff-only');

  // Critical: stolen photos (+20 duplicate, +50 stolen) on top -> auto-rejected, flagged, admins told; appeal -> uphold.
  const phash = (await pool.query('SELECT phash FROM property_media WHERE property_id = $1 LIMIT 1', [green.data.id])).rows[0].phash;
  await pool.query(`INSERT INTO property_media (property_id, url, phash, scan_status) VALUES ($1, 'https://img.example/stolen.jpg', $2, 'clean')`, [red.data.id, phash]);
  const crit = await api('POST', `/fraud/listings/${red.data.id}/assess`, { token: S });
  assert.equal(crit.data.band, 'critical');
  assert.equal(crit.data.action, 'auto_rejected');
  assert.ok(crit.data.factors.some((f) => f.key === 'stolen_content'));
  assert.ok((await pool.query(`SELECT 1 FROM user_flags WHERE user_id = $1 AND reason = 'critical_listing'`, [brokerC.id])).rows.length);
  assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'fraud_alert'`, [ctx.admin.id])).rows.length);
  const appeal = await api('POST', `/fraud/listings/${red.data.id}/appeal`, { token: brokerC.token, body: { reason: 'These are my own photos; I shot them at the site.' } });
  assert.equal(appeal.status, 201);
  assert.equal((await api('PUT', `/fraud/appeals/${appeal.data.id}`, { token: S, body: { decision: 'uphold' } })).status, 403, 'admins decide appeals');
  await api('PUT', `/fraud/appeals/${appeal.data.id}`, { token: A, body: { decision: 'uphold', note: 'Photos verified' } });
  assert.equal((await pool.query('SELECT status FROM properties WHERE id = $1', [red.data.id])).rows[0].status, 'approved');

  // Repeat critical rejections -> suspension.
  await pool.query(`INSERT INTO user_flags (user_id, reason) VALUES ($1, 'critical_listing'), ($1, 'critical_listing')`, [brokerC.id]);
  const again = await api('POST', '/properties', { token: brokerC.token, body: mk({ description: `Pay advance via crypto now ${RUN} ${Math.random()}` }) });
  await pool.query(`INSERT INTO property_media (property_id, url, phash, scan_status) VALUES ($1, 'https://img.example/stolen2.jpg', $2, 'clean')`, [again.data.id, phash]);
  const suspended = await api('POST', `/fraud/listings/${again.data.id}/assess`, { token: S });
  assert.equal(suspended.data.action, 'auto_rejected_and_suspended');
  assert.equal((await pool.query('SELECT status FROM users WHERE id = $1', [brokerC.id])).rows[0].status, 'suspended');
  await pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [brokerC.id]);

  // Staff clears a flagged listing.
  await api('PUT', `/fraud/listings/${flagged.data.id}/review`, { token: S, body: { action: 'clear' } });
  assert.equal((await pool.query('SELECT under_review FROM properties WHERE id = $1', [flagged.data.id])).rows[0].under_review, false);
  assert.equal((await api('PUT', `/fraud/listings/${flagged.data.id}/review`, { token: S, body: { action: 'reject' } })).status, 400, 'reason required');

  // L2 Seller Verified: all checks required; L3 auto-requested above Rs 1 Cr.
  await api('POST', `/fraud/listings/${green.data.id}/verifications`, { token: brokerA.token, body: { level: 2, note: 'Sale deed uploaded' } });
  const partial = await api('PUT', `/fraud/listings/${green.data.id}/verifications/2`, { token: S, body: { status: 'verified', checks: { ownership_proof: true } } });
  assert.equal(partial.status, 400);
  const l2 = await api('PUT', `/fraud/listings/${green.data.id}/verifications/2`, {
    token: S,
    body: { status: 'verified', checks: { ownership_proof: true, id_verified: true, callback_done: true, photos_recent: true } },
  });
  assert.equal(l2.data.verificationLevel, 2);
  const g2 = (await pool.query('SELECT verification_level, is_verified FROM properties WHERE id = $1', [green.data.id])).rows[0];
  assert.deepEqual(g2, { verification_level: 2, is_verified: true });
  const pricey = await api('POST', '/properties', { token: brokerA.token, body: mk({ price: '2.4 Cr' }) });
  const l3 = await pool.query(`SELECT status, auto_requested FROM property_verifications WHERE property_id = $1 AND level = 3`, [pricey.data.id]);
  assert.deepEqual(l3.rows[0], { status: 'requested', auto_requested: true });
  const search = await api('GET', `/search/properties?city=${encodeURIComponent(FCITY)}`);
  assert.equal(search.data.items[0].verification_level, 2, 'Seller Verified ranks first (+15 boost)');

  // Image scan: visiting-card shape flagged (heuristic without AI), photo fingerprinted.
  const { Jimp } = require('jimp');
  const scan = async (w, h) => {
    const buf = await new Jimp({ width: w, height: h, color: 0x3366ccff }).getBuffer('image/jpeg');
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'image/jpeg' }), 'x.jpg');
    const res = await fetch(`${BASE}/fraud/scan-image`, { method: 'POST', headers: { Authorization: `Bearer ${S}` }, body: form });
    return (await res.json()).data;
  };
  const card = await scan(900, 520);
  assert.equal(card.width, 900);
  assert.match(card.phash, /^-?\d+$/);
  if (!card.scan.ai) assert.equal(card.scan.status, 'flagged');
  assert.equal((await scan(800, 800)).scan.status === 'blocked', false);
});

// ---------------------------- Due diligence, document repository, disputes & lead conflicts (Engine 5, sec. 9.6)

test('due diligence + disputes: checklist, AI/rule classification, title chain, encumbrance, visibility, NRI, cases, lead conflicts', async () => {
  const A = ctx.admin.token;
  const S = ctx.sales.token;
  const DCITY = `DD City ${RUN}`;
  const brokerA = await createUser('broker', 'ddA');
  const brokerB = await createUser('broker', 'ddB');
  await pool.query(`UPDATE users SET mobile_verified = true WHERE id = ANY($1::uuid[])`, [[brokerA.id, brokerB.id]]);
  const listing = await api('POST', '/properties', {
    token: brokerA.token,
    body: { ...baseListing(), title: `DD flat ${RUN}`, description: `Resale home for due diligence ${RUN}`, city: DCITY, price: '80 Lakh', possessionStatus: 'Ready to move' },
  });
  const P = listing.data.id;

  // Empty report -> checklist with missing required documents.
  const empty = await api('GET', `/due-diligence/properties/${P}`, { token: brokerA.token });
  assert.equal(empty.data.status, 'not_started');
  const types = empty.data.checklist.map((c) => c.type);
  assert.ok(['sale_deed', 'encumbrance_certificate', 'occupancy_certificate', 'id_proof'].every((t) => types.includes(t)));
  assert.ok(empty.data.missing.length >= 5);
  assert.equal((await api('GET', `/due-diligence/properties/${P}`, { token: brokerB.token })).status, 403, 'no relationship, no access');

  // Classifier on a generated PDF (rules without an AI key).
  // Minimal uncompressed PDF (the shape scanners / Word exports produce).
  const makePdf = (lines) => {
    const stream = `BT /F1 11 Tf 40 780 Td 14 TL ${lines.map((l) => `(${l}) '`).join(' ')} ET`;
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let out = '%PDF-1.4\n';
    const offsets = [];
    objs.forEach((o, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(out, 'latin1');
  };
  const deedPdf = makePdf(['SALE DEED', 'This deed of sale is executed on 12-03-2001 between the vendor and the purchaser.', 'The property is subject to an equitable mortgage with the bank.', 'Signature of executant and witness.']);
  const form = new FormData();
  form.append('file', new Blob([deedPdf], { type: 'application/pdf' }), 'deed.pdf');
  const analysed = await (await fetch(`${BASE}/due-diligence/analyse`, { method: 'POST', headers: { Authorization: `Bearer ${S}` }, body: form })).json();
  assert.equal(analysed.data.type, 'sale_deed');
  assert.ok(analysed.data.extracted.dates.includes('2001-03-12'));
  assert.ok(analysed.data.flags.some((f) => f.category === 'encumbrance'));

  // Documents with role visibility; EC showing a charge and no bank NOC -> issues.
  const add = (body, token = brokerA.token) => api('POST', `/due-diligence/properties/${P}/documents`, { token, body });
  await add({ documentType: 'sale_deed', documentUrl: `documents/properties/${P}/deed.pdf`, visibleTo: ['owner', 'broker', 'buyer'] });
  const ec = await add({ documentType: 'encumbrance_certificate', documentUrl: `documents/properties/${P}/ec.pdf` });
  await pool.query(`UPDATE documents SET ai_flags = $1 WHERE id = $2`, [JSON.stringify([{ category: 'encumbrance', severity: 'medium', detail: 'Mortgage to bank shown' }]), ec.data.id]);
  assert.equal((await add({ documentType: 'tax_receipt', documentUrl: 'x' }, brokerB.token)).status, 403);
  const withDocs = await api('GET', `/due-diligence/properties/${P}`, { token: brokerA.token });
  assert.equal(withDocs.data.encumbrance.status, 'charged');
  assert.ok(withDocs.data.checklist.some((c) => c.type === 'bank_noc' && c.required && !c.present), 'loan needs a bank NOC');
  assert.equal(withDocs.data.status, 'issues');
  assert.ok(withDocs.data.riskFlags.some((f) => /bank NOC/.test(f.detail)));

  // Title chain from staff-entered links: 30+ years with a break.
  await api('POST', `/due-diligence/properties/${P}/title-links`, { token: S, body: { date: '1994-01-10', from: 'Anil Sharma', to: 'Bina Verma' } });
  const chained = await api('POST', `/due-diligence/properties/${P}/title-links`, { token: S, body: { date: '2010-05-20', from: 'Chetan Gupta', to: 'Current Owner' } });
  assert.ok(chained.data.titleChain.years >= 30);
  assert.equal(chained.data.titleChain.gaps.length, 1);
  assert.equal((await api('POST', `/due-diligence/properties/${P}/title-links`, { token: brokerA.token, body: { date: '2000-01-01' } })).status, 403);

  // Buyer at negotiation sees only buyer-visible documents.
  const buyerUser = await createUser('customer', 'ddbuyer');
  await api('GET', '/me/profile', { token: buyerUser.token });
  const buyerCust = (await pool.query('SELECT id FROM customers WHERE user_id = $1', [buyerUser.id])).rows[0].id;
  await pool.query(`INSERT INTO deals (customer_id, broker_id, property_id, stage) VALUES ($1, $2, $3, 'negotiation')`, [buyerCust, brokerA.id, P]);
  const buyerDocs = await api('GET', `/due-diligence/properties/${P}/documents`, { token: buyerUser.token });
  assert.deepEqual(buyerDocs.data.roles, ['buyer']);
  assert.deepEqual(buyerDocs.data.documents.map((d) => d.document_type), ['sale_deed']);
  await api('PUT', `/due-diligence/documents/${ec.data.id}/review`, { token: S, body: { status: 'rejected', notes: 'Illegible' } });
  const afterReject = await api('GET', `/due-diligence/properties/${P}`, { token: S });
  assert.ok(afterReject.data.checklist.find((c) => c.type === 'encumbrance_certificate').present === false, 'rejected documents do not count');

  // NRI seller -> considerations + power-of-attorney item.
  const nriSeller = await createUser('customer', 'ddnri');
  await api('PUT', '/investors/me', { token: nriSeller.token, body: { isNri: true, countryOfResidence: 'United Arab Emirates' } });
  const nriListing = await api('POST', '/me/listings', {
    token: nriSeller.token,
    body: { title: `NRI owned flat ${RUN}`, propertyType: 'apartment', transactionType: 'sell', price: '95 Lakh', city: DCITY, locality: 'Delta', consentToken: await consent(nriSeller.token) },
  });
  const nriReport = await api('GET', `/due-diligence/properties/${nriListing.data.id}`, { token: nriSeller.token });
  assert.equal(nriReport.data.nri.seller, true);
  assert.ok(nriReport.data.nri.points.some((p) => /Section 195/.test(p)));
  assert.ok(nriReport.data.checklist.some((c) => c.type === 'power_of_attorney'));

  // Disputes: open, respond, internal note hidden, awaiting info, reconstruct, resolve; timeline append-only.
  const dispute = await api('POST', '/disputes', {
    token: brokerA.token,
    body: { type: 'broker_dispute', title: `Commission claim ${RUN}`, description: 'Broker B claims my client after I did the site visit.', againstUserId: brokerB.id, propertyId: P },
  });
  assert.equal(dispute.status, 201);
  assert.match(dispute.data.case_number, /^DSP-\d{4}-\d{5}$/);
  const due = (new Date(dispute.data.sla_due_at) - Date.now()) / 3600000;
  assert.ok(due > 47 && due <= 48, '48-hour SLA');
  const D = dispute.data.id;
  assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'dispute'`, [brokerB.id])).rows.length);
  assert.equal((await api('GET', `/disputes/${D}`, { token: (await createUser('broker', 'ddC')).token })).status, 403);
  await api('POST', `/disputes/${D}/comments`, { token: brokerB.token, body: { body: 'I introduced the buyer first.' } });
  await api('POST', `/disputes/${D}/comments`, { token: S, body: { body: 'Check call logs', internal: true } });
  assert.ok(!(await api('GET', `/disputes/${D}`, { token: brokerA.token })).data.timeline.some((e) => e.visibility === 'internal'));
  assert.ok((await api('GET', `/disputes/${D}`, { token: S })).data.timeline.some((e) => e.visibility === 'internal'));
  await api('PUT', `/disputes/${D}`, { token: S, body: { status: 'awaiting_info', note: 'Share visit proof' } });
  await api('POST', `/disputes/${D}/comments`, { token: brokerA.token, body: { body: 'Visit was on the 5th.' } });
  assert.equal((await api('GET', `/disputes/${D}`, { token: S })).data.status, 'under_review');
  const trail = await api('GET', `/disputes/${D}/reconstruction`, { token: S });
  assert.ok(trail.data.events.some((e) => e.source === 'audit') && trail.data.events.some((e) => e.source === 'case'));
  assert.equal((await api('POST', `/disputes/${D}/resolve`, { token: S, body: { decision: 'resolve', resolution: 'x' } })).status, 403);
  const closed = await api('POST', `/disputes/${D}/resolve`, { token: A, body: { decision: 'resolve', resolution: 'Broker A did the visit; 60/40 split.', inFavourOf: brokerA.id, outcome: { split: { A: 60, B: 40 } } } });
  assert.equal(closed.data.status, 'resolved');
  await assert.rejects(pool.query('DELETE FROM dispute_events WHERE dispute_id = $1', [D]), /append-only/);
  const trustB = await api('GET', '/trust/me?refresh=true', { token: brokerB.token });
  assert.equal(trustB.data.inputs.disputes.total, 1);

  // Overdue escalation.
  const late = await api('POST', '/disputes', { token: brokerB.token, body: { type: 'fake_claim', title: `Fake claim ${RUN}`, description: 'This listing claims amenities that do not exist.', propertyId: P } });
  await pool.query(`UPDATE disputes SET sla_due_at = now() - interval '1 hour' WHERE id = $1`, [late.data.id]);
  const esc = await require('../src/services/dispute.service').escalateOverdue();
  assert.ok(esc.escalated >= 1);
  assert.equal((await api('GET', `/disputes/${late.data.id}`, { token: S })).data.priority, 'high');

  // Lead conflicts: same phone in two brokers' CRMs.
  const mobile = `9${String(parseInt(RUN, 16) % 1e9).padStart(9, '0')}`;
  const mkCustomer = async (name) => (await pool.query(`INSERT INTO customers (full_name, mobile) VALUES ($1, $2) RETURNING id`, [name, mobile])).rows[0].id;
  const leadA = await api('POST', '/leads', { token: brokerA.token, body: { customerId: await mkCustomer(`Ravi Kumar ${RUN}`), source: 'manual', propertyId: P, assignedTo: brokerA.id } });
  assert.equal(leadA.status, 201, JSON.stringify(leadA.body));
  await pool.query(`INSERT INTO lead_notes (lead_id, user_id, note) VALUES ($1, $2, 'Called the buyer')`, [leadA.data.id, brokerA.id]);
  await new Promise((r) => setTimeout(r, 20));
  const leadB = await api('POST', '/leads', { token: brokerB.token, body: { customerId: await mkCustomer(`Ravi K ${RUN}`), source: 'manual', assignedTo: brokerB.id } });
  const conflicts = await api('GET', '/disputes/lead-conflicts', { token: brokerB.token });
  const lc = conflicts.data.find((c) => c.later_lead_id === leadB.data.id);
  assert.ok(lc && lc.i_am_later && lc.first_broker_id === brokerA.id);
  assert.equal(lc.customer_name, 'Ravi', 'brokers see only the first name');
  assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'lead_conflict'`, [brokerA.id])).rows.length);
  assert.equal((await api('PUT', `/disputes/lead-conflicts/${lc.id}`, { token: brokerB.token, body: { action: 'different_property', propertyId: P } })).status, 400, 'first broker already works that property');
  const attribution = await api('GET', `/disputes/lead-conflicts/${lc.id}/attribution`, { token: brokerB.token });
  assert.equal(attribution.data.steps[0].by.startsWith('ddA'), true, 'first contact credited to the first broker');
  await api('PUT', `/disputes/lead-conflicts/${lc.id}`, { token: brokerB.token, body: { action: 'request_routing' } });
  assert.equal((await api('PUT', `/disputes/lead-conflicts/${lc.id}`, { token: brokerB.token, body: { action: 'accept_routing' } })).status, 403);
  const routed = await api('PUT', `/disputes/lead-conflicts/${lc.id}`, { token: brokerA.token, body: { action: 'accept_routing' } });
  assert.equal(routed.data.resolution, 'mandate_routing');

  // A third broker transfers; a fourth escalates -> dispute -> admin decides.
  const brokerC = await createUser('broker', 'ddLateC');
  const leadC = await api('POST', '/leads', { token: brokerC.token, body: { customerId: await mkCustomer(`Ravi ${RUN}`), source: 'manual', assignedTo: brokerC.id } });
  const lcC = (await api('GET', '/disputes/lead-conflicts', { token: brokerC.token })).data.find((c) => c.later_lead_id === leadC.data.id);
  await api('PUT', `/disputes/lead-conflicts/${lcC.id}`, { token: brokerC.token, body: { action: 'transfer' } });
  assert.equal((await pool.query('SELECT assigned_to FROM leads WHERE id = $1', [leadC.data.id])).rows[0].assigned_to, brokerA.id);
  const brokerE = await createUser('broker', 'ddLateE');
  const leadE = await api('POST', '/leads', { token: brokerE.token, body: { customerId: await mkCustomer(`R Kumar ${RUN}`), source: 'manual', assignedTo: brokerE.id } });
  const lcE = (await api('GET', '/disputes/lead-conflicts', { token: brokerE.token })).data.find((c) => c.later_lead_id === leadE.data.id);
  const escalated = await api('POST', `/disputes/lead-conflicts/${lcE.id}/escalate`, { token: brokerE.token, body: { reason: 'I met the buyer first offline.' } });
  assert.equal(escalated.data.type, 'lead_conflict');
  await api('POST', `/disputes/${escalated.data.id}/resolve`, { token: A, body: { decision: 'resolve', resolution: 'First broker keeps the buyer per the activity log.', inFavourOf: brokerA.id } });
  const lcEAfter = (await pool.query('SELECT status, resolution FROM lead_conflicts WHERE id = $1', [lcE.id])).rows[0];
  assert.deepEqual(lcEAfter, { status: 'resolved', resolution: 'admin_decided' });
});

test('orchestration + invoices + intelligence + reputation: gating, auto-advance, SLA, health, Instalment 1/2, GST/IGST, network score', async () => {
  const A = ctx.admin.token;
  const S = ctx.sales.token;
  const OCITY = `Orch City ${RUN}`;
  const broker = await createUser('broker', 'orchB');
  await pool.query(`UPDATE users SET mobile_verified = true WHERE id = $1`, [broker.id]);
  const listing = await api('POST', '/properties', { token: broker.token, body: { ...baseListing(), title: `Orch flat ${RUN}`, city: OCITY, price: '1 Cr' } });
  const P = listing.data.id;
  const buyer = await createUser('customer', 'orchbuyer');
  await api('GET', '/me/profile', { token: buyer.token });
  const buyerCust = (await pool.query('SELECT id FROM customers WHERE user_id = $1', [buyer.id])).rows[0].id;
  const deal = await api('POST', '/deals', { token: S, body: { customerId: buyerCust, propertyId: P, brokerId: broker.id } });
  assert.equal(deal.status, 201, JSON.stringify(deal.body));
  const D = deal.data.id;
  const view = () => api('GET', `/orchestration/deals/${D}`, { token: broker.token });
  const evaluate = () => api('POST', `/orchestration/deals/${D}/evaluate`, { token: S });

  // Contract pipeline. Dependency enforcement: no requirement, no Requirement stage; broker cannot override.
  assert.equal(deal.data.stage, 'inquiry', 'Lead until the requirement is captured');
  const blocked = await api('PUT', `/deals/${D}/stage`, { token: broker.token, body: { stage: 'requirement' } });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.message, /requirement/i);
  assert.equal((await api('PUT', `/deals/${D}/stage`, { token: broker.token, body: { stage: 'site_visit' } })).status, 400, 'no skipping stages');
  assert.equal((await api('PUT', `/deals/${D}/stage`, { token: broker.token, body: { stage: 'requirement', override: true, notes: 'x' } })).status, 403);
  const v0 = await view();
  assert.equal(v0.data.next, 'requirement');
  assert.equal(v0.data.nextRequirements[0].met, false);
  assert.equal(v0.data.stageLabels.inquiry, 'Lead');

  // Auto-advance: requirement captured -> Requirement -> Match (property linked); visit -> Site Visit; done -> Negotiation; value -> Legal Coordination.
  await pool.query(`INSERT INTO customer_preferences (customer_id, budget_max) VALUES ($1, 12000000) ON CONFLICT (customer_id) DO NOTHING`, [buyerCust]);
  const matched = await evaluate();
  assert.equal(matched.data.stage, 'match');
  assert.deepEqual(matched.data.advanced, ['requirement', 'match']);
  const visit = await api('POST', `/deals/${D}/site-visit`, { token: broker.token, body: { scheduledAt: new Date(Date.now() + 86400000).toISOString() } });
  assert.equal((await evaluate()).data.stage, 'site_visit');
  await api('PUT', `/deals/${D}/site-visit/${visit.data.id}`, { token: broker.token, body: { status: 'completed', actualVisitAt: new Date().toISOString() } });
  assert.equal((await evaluate()).data.stage, 'negotiation');
  await api('PUT', `/deals/${D}`, { token: broker.token, body: { dealValue: 10000000 } });
  const booked = await evaluate();
  assert.equal(booked.data.stage, 'legal_coordination');
  assert.equal(booked.data.next, 'loan_referral');

  // Execution dates: no Sale Deed before ATS, no future dates.
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await api('PUT', `/orchestration/deals/${D}/dates`, { token: broker.token, body: { saleDeedExecutionDate: today } })).status, 400);
  assert.equal((await api('PUT', `/orchestration/deals/${D}/dates`, { token: broker.token, body: { atsExecutionDate: '2999-01-01' } })).status, 400);
  const ats = await api('PUT', `/orchestration/deals/${D}/dates`, { token: broker.token, body: { atsExecutionDate: today } });
  assert.equal(ats.status, 200, JSON.stringify(ats.body));
  assert.equal(ats.data.stage, 'loan_referral');
  let invoices = (await api('GET', `/orchestration/invoices?dealId=${D}`, { token: S })).data;
  const inv1 = invoices.find((i) => i.kind === 'instalment_1');
  assert.ok(inv1, 'Instalment 1 raised on ATS execution');
  assert.equal(Number(inv1.fee_amount), 50000, '50% of 1% of 1 Cr');
  assert.equal(inv1.gst_type, 'cgst_sgst');
  assert.equal(Number(inv1.cgst_amount), 4500);
  assert.equal(Number(inv1.sgst_amount), 4500);
  assert.equal(Number(inv1.total_amount), 59000);
  assert.equal(inv1.gstin, '07DERPR1574G2ZY');
  assert.match(inv1.invoice_number, /^ARB\/\d{4}-\d{2}\/\d{6}$/);
  // Due date against the invoice's own issue date (the database's date, not this process's UTC date).
  assert.equal(Math.round((new Date(inv1.due_date) - new Date(inv1.issue_date)) / 86400000), 7, 'net 7');
  assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'invoice'`, [buyer.id])).rows.length, 'buyer notified');

  // Loan referral (referral-only) -> Insurance Referral; insurance not needed still waits for the approved agreement.
  assert.equal((await api('PUT', `/orchestration/deals/${D}/referrals`, { token: broker.token, body: { loanStatus: 'approved' } })).status, 400);
  const loan = await api('PUT', `/orchestration/deals/${D}/referrals`, { token: broker.token, body: { loanStatus: 'referred', loanLender: 'HDFC Bank' } });
  assert.equal(loan.status, 200, JSON.stringify(loan.body));
  assert.equal(loan.data.stage, 'insurance_referral');
  const ins = await api('PUT', `/orchestration/deals/${D}/referrals`, { token: broker.token, body: { insuranceStatus: 'not_needed' } });
  assert.equal(ins.data.stage, 'insurance_referral');
  assert.ok(ins.data.nextRequirements.some((r) => r.key === 'agreement_approved' && !r.met));
  assert.equal((await view()).data.referrals.loanLender, 'HDFC Bank');

  // Signed agreement approved -> Payment Confirmation.
  const doc = (await pool.query(`INSERT INTO documents (deal_id, customer_id, document_type, document_url, uploaded_by) VALUES ($1, $2, 'agreement_to_sell', 'documents/x/ats.pdf', $3) RETURNING id`, [D, buyerCust, broker.id])).rows[0];
  await api('PUT', `/due-diligence/documents/${doc.id}/review`, { token: S, body: { status: 'approved' } });
  assert.equal((await evaluate()).data.stage, 'payment');

  // Sale Deed -> Instalment 2; closing waits for both instalments to be paid.
  await api('PUT', `/orchestration/deals/${D}/dates`, { token: broker.token, body: { saleDeedExecutionDate: today } });
  invoices = (await api('GET', `/orchestration/invoices?dealId=${D}`, { token: S })).data;
  const inv2 = invoices.find((i) => i.kind === 'instalment_2');
  assert.ok(inv2 && /Sub-Registrar/.test(inv2.note));
  assert.equal((await view()).data.stage, 'payment');
  assert.equal((await api('PUT', `/deals/${D}/close`, { token: broker.token, body: { outcome: 'won' } })).status, 400, 'cannot close with fees unpaid');
  assert.equal((await api('POST', `/orchestration/invoices/${inv1.id}/payment`, { token: broker.token, body: { reference: 'UTR1' } })).status, 403);
  await api('POST', `/orchestration/invoices/${inv1.id}/payment`, { token: S, body: { reference: 'UTR1' } });
  assert.equal((await view()).data.stage, 'payment');
  const paid = await api('POST', `/orchestration/invoices/${inv2.id}/payment`, { token: S, body: { reference: 'UTR2' } });
  assert.equal(paid.data.stage, 'closed_won', 'auto-closed once everything is paid');
  const events = (await pool.query(`SELECT kind FROM orchestration_events WHERE deal_id = $1`, [D])).rows.map((r) => r.kind);
  assert.ok(events.filter((k) => k === 'auto_advance').length >= 6);
  await assert.rejects(pool.query('DELETE FROM orchestration_events WHERE deal_id = $1', [D]), /append-only/);

  // PDF + visibility: buyer sees own invoices and my-deals; another broker cannot.
  const pdf = await fetch(`${BASE}/orchestration/invoices/${inv1.id}/pdf`, { headers: { authorization: `Bearer ${buyer.token}` } });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  const other = await createUser('broker', 'orchOther');
  assert.equal((await api('GET', `/orchestration/invoices/${inv1.id}/pdf`, { token: other.token })).status, 404);
  assert.equal((await api('GET', `/orchestration/deals/${D}`, { token: other.token })).status, 403);
  const myDeals = await api('GET', '/orchestration/my-deals', { token: buyer.token });
  assert.equal(myDeals.data[0].stage, 'closed_won');
  assert.equal(myDeals.data[0].invoices.length, 2);

  // NRI buyer -> IGST 18%; admin override with a logged reason.
  const nri = await createUser('customer', 'orchnri');
  await api('PUT', '/investors/me', { token: nri.token, body: { isNri: true, countryOfResidence: 'Singapore' } });
  await api('GET', '/me/profile', { token: nri.token });
  const nriCust = (await pool.query('SELECT id FROM customers WHERE user_id = $1', [nri.id])).rows[0].id;
  const D2 = (await api('POST', '/deals', { token: S, body: { customerId: nriCust, propertyId: P, brokerId: broker.id, dealValue: 20000000 } })).data.id;
  assert.equal((await api('PUT', `/deals/${D2}/stage`, { token: A, body: { stage: 'requirement', override: true } })).status, 400, 'override needs a reason');
  const over = await api('PUT', `/deals/${D2}/stage`, { token: A, body: { stage: 'requirement', override: true, notes: 'Requirement taken on a call, notes on file' } });
  assert.equal(over.status, 200);
  assert.ok((await pool.query(`SELECT 1 FROM orchestration_events WHERE deal_id = $1 AND kind = 'override'`, [D2])).rows.length);
  await api('PUT', `/orchestration/deals/${D2}/dates`, { token: S, body: { atsExecutionDate: today } });
  const nriInv = (await api('GET', `/orchestration/invoices?dealId=${D2}`, { token: S })).data[0];
  assert.equal(nriInv.gst_type, 'igst');
  assert.equal(Number(nriInv.igst_amount), 18000);
  assert.equal(Number(nriInv.cgst_amount), 0);

  // SLA delay alert (once per stage), overdue invoice, health score.
  const orch = require('../src/services/orchestration.service');
  await pool.query(`UPDATE deals SET stage_entered_at = now() - interval '40 days' WHERE id = $1`, [D2]);
  await pool.query(`UPDATE invoices SET due_date = CURRENT_DATE - 2 WHERE id = $1`, [nriInv.id]);
  assert.ok((await orch.slaSweep()).alerted >= 1);
  assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'deal_sla' AND related_entity_id = $2`, [broker.id, D2])).rows.length);
  const again = await orch.slaSweep();
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM orchestration_events WHERE deal_id = $1 AND kind = 'sla_alert'`, [D2])).rows[0].n, 1, `alert once (${again.alerted})`);
  assert.ok((await orch.invoiceSweep()).overdue >= 1);
  assert.equal((await pool.query('SELECT status FROM invoices WHERE id = $1', [nriInv.id])).rows[0].status, 'overdue');
  assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'invoice_overdue'`, [nri.id])).rows.length);
  const health = (await api('GET', `/orchestration/deals/${D2}`, { token: S })).data.health;
  assert.ok(health.score < 70 && ['at_risk', 'critical'].includes(health.band), JSON.stringify(health));
  assert.ok(health.factors.some((f) => /SLA/.test(f.label)) && health.factors.some((f) => /invoice/i.test(f.label)));

  // Deal intelligence.
  const intel = await api('GET', '/orchestration/intelligence', { token: S });
  assert.equal(intel.data.scope, 'all');
  assert.ok(intel.data.funnel.find((f) => f.stage === 'closed_won').reached >= 1);
  // Top 15 cities by deal count - on a long-lived dev DB this run's city may rank lower.
  const byCity = intel.data.conversion.byCity;
  assert.ok(byCity.length > 0 && byCity.every((c) => c.won <= c.deals));
  assert.ok(byCity.some((c) => c.key === OCITY && c.won >= 1) || byCity.length === 15);
  // Recommendations cover the 8 most at-risk deals (D2 may rank lower on a shared dev database).
  const topRisk = intel.data.atRisk.slice(0, 8).map((d) => d.id);
  assert.ok(topRisk.length > 0 && topRisk.every((id) => intel.data.recommendations.some((r) => r.dealId === id)));
  const mine = await api('GET', '/orchestration/intelligence', { token: broker.token });
  assert.equal(mine.data.scope, 'mine');
  // Checked in the broker's own view: the staff list shows only the 25 worst deals platform-wide.
  assert.ok(mine.data.atRisk.some((d) => d.id === D2));
  assert.equal(mine.data.conversion.byBroker.length, 0);
  assert.equal((await api('GET', '/orchestration/intelligence', { token: buyer.token })).status, 403);

  // Reputation graph: vouch + co-listing lift R1 by a bounded amount; shared-IP pair excluded.
  const [r1, r2, r3, r4] = [await createUser('broker', 'rep1'), await createUser('broker', 'rep2'), await createUser('broker', 'rep3'), await createUser('broker', 'rep4')];
  await pool.query(`UPDATE users SET created_at = now() - interval '90 days' WHERE id = ANY($1::uuid[])`, [[r1.id, r2.id, r3.id, r4.id]]);
  for (const u of [r2, r3, r4]) {
    await pool.query(`INSERT INTO trust_scores (user_id, score) VALUES ($1, 90) ON CONFLICT (user_id) DO UPDATE SET score = 90`, [u.id]);
  }
  assert.equal((await api('POST', '/reputation/vouch', { token: r1.token, body: { userId: r1.id } })).status, 400, 'no self vouch');
  assert.equal((await api('POST', '/reputation/vouch', { token: r1.token, body: { userId: r2.id } })).status, 403, 'low-trust brokers cannot vouch');
  const vouch = await api('POST', '/reputation/vouch', { token: r2.token, body: { userId: r1.id, note: 'Closed deals with them' } });
  assert.equal(vouch.status, 201);
  assert.equal((await api('POST', '/reputation/vouch', { token: r2.token, body: { userId: r1.id } })).status, 400, 'one live vouch per pair');
  const r3Prop = (await pool.query(`INSERT INTO properties (created_by, title, property_type, transaction_type, city, price) VALUES ($1, $2, 'apartment', 'sell', $3, '50 Lakh') RETURNING id`, [r3.id, `Rep co-listing ${RUN}`, OCITY])).rows[0].id;
  await pool.query(`INSERT INTO property_partners (property_id, partner_user_id, split_percent) VALUES ($1, $2, 50)`, [r3Prop, r1.id]);
  const r4Prop = (await pool.query(`INSERT INTO properties (created_by, title, property_type, transaction_type, city, price) VALUES ($1, $2, 'apartment', 'sell', $3, '50 Lakh') RETURNING id`, [r4.id, `Rep sock ${RUN}`, OCITY])).rows[0].id;
  await pool.query(`INSERT INTO property_partners (property_id, partner_user_id, split_percent) VALUES ($1, $2, 50)`, [r4Prop, r1.id]);
  await pool.query(`INSERT INTO user_ips (user_id, ip) VALUES ($1, '203.0.113.77'), ($2, '203.0.113.77')`, [r1.id, r4.id]);
  const rec = await api('POST', '/reputation/recompute', { token: A });
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  const rep = await api('GET', '/reputation/me', { token: r1.token });
  assert.equal(rep.data.neighbours, 2, 'r2 (vouch) + r3 (co-listing); r4 excluded');
  assert.ok(rep.data.adjustment > 0 && rep.data.adjustment <= 5, JSON.stringify(rep.data));
  assert.ok(rep.data.excluded.some((e) => e.with === r4.id && e.reason === 'shared_ip'));
  assert.equal(rep.data.received.length, 1);
  const trust = await api('GET', '/trust/me?refresh=true', { token: r1.token });
  assert.equal(trust.data.inputs.networkAdjustment, rep.data.adjustment);
  const graph = await api('GET', '/reputation/graph', { token: r1.token });
  assert.ok(graph.data.nodes.some((n) => n.id === r2.id) && graph.data.edges.length >= 2);
  assert.ok(!graph.data.nodes.some((n) => n.id === r4.id));
  assert.equal((await api('GET', '/reputation/graph?scope=global', { token: S })).status, 200);
  assert.equal((await api('DELETE', `/reputation/vouch/${vouch.data.id}`, { token: r1.token })).status, 404, 'only the voucher revokes');
  assert.equal((await api('DELETE', `/reputation/vouch/${vouch.data.id}`, { token: r2.token })).status, 200);
});

test('mandates: OTP fee consent, encrypted price range, rep-only access, activation, renewal cap, deal panel, expiry, breach, PDFs', async () => {
  const S = ctx.superAdmin.token;
  const A = ctx.admin.token;
  const RM = ctx.sales.token;
  const MCITY = `Mandate City ${RUN}`;
  const seller = await createUser('customer', 'mndseller');
  const buyer = await createUser('customer', 'mndbuyer');
  const SELLER_MIN = 13777777;
  const BUYER_MAX = 16222222;
  const body = {
    title: `Mandate 3 BHK ${RUN}`, propertyType: 'apartment', transactionType: 'sell', price: '1.5 Cr',
    city: MCITY, locality: 'Sector 9', areaSqft: 1600, bedrooms: 3,
  };

  // Consent is unbypassable: no token, wrong OTP, missing range, reused token.
  assert.equal((await api('POST', '/me/listings', { token: seller.token, body })).status, 422);
  await api('POST', '/mandates/consent/otp', { token: seller.token });
  assert.equal((await api('POST', '/mandates/consent/verify', { token: seller.token, body: { otp: '000000', kind: 'listing' } })).status, 400);
  const terms = await api('GET', '/mandates/consent-terms', { token: seller.token });
  assert.equal(terms.data.feeRatePercent, 1);
  assert.equal(terms.data.mandatePeriodDays.seller, 180);
  const tok = await consent(seller.token);
  const noRange = await api('POST', '/me/listings', { token: seller.token, body: { ...body, consentToken: tok, mandateType: 'exclusive' } });
  assert.equal(noRange.status, 400);
  const badRange = await api('POST', '/me/listings', { token: seller.token, body: { ...body, consentToken: tok, mandateType: 'exclusive', priceRange: { minPrice: 9, maxPrice: 5 } } });
  assert.equal(badRange.status, 400);
  const wrongKind = await api('POST', '/me/listings', { token: seller.token, body: { ...body, consentToken: await consent(seller.token, 'requirement') } });
  assert.equal(wrongKind.status, 400);
  const listing = await api('POST', '/me/listings', {
    token: seller.token,
    body: { ...body, consentToken: tok, mandateType: 'exclusive', priceRange: { minPrice: SELLER_MIN, maxPrice: 15500000 } },
  });
  assert.equal(listing.status, 201, JSON.stringify(listing.body));
  assert.equal(listing.data.mandate.type, 'seller_exclusive');
  assert.equal(listing.data.mandate.status, 'pending_rep_ack');
  assert.equal((await api('POST', '/me/listings', { token: seller.token, body: { ...body, title: `Again ${RUN}`, consentToken: tok } })).status, 400, 'consent token is single-use');
  const mid = listing.data.mandate.id;
  const stored = (await pool.query('SELECT * FROM mandates WHERE id = $1', [mid])).rows[0];
  assert.match(stored.seller_min_price_enc, /^v1:/);
  assert.equal(String(stored.seller_min_price_enc).includes(String(SELLER_MIN)), false);
  assert.equal(Number(stored.professional_fee_rate_percent), 1);
  assert.ok(stored.fee_consent_id);
  assert.equal((await pool.query('SELECT mandate_type FROM properties WHERE id = $1', [listing.data.id])).rows[0].mandate_type, 'standard', 'no exclusive placement before rep acknowledgement');
  const audit = await pool.query(`SELECT 1 FROM audit_logs WHERE actor_id = $1 AND action = 'professional_fee_consent_accepted'`, [seller.id]);
  assert.ok(audit.rows.length >= 1);

  // Buyer exclusive requirement with a confidential budget.
  const req = await api('POST', '/me/requirements', {
    token: buyer.token,
    body: {
      purpose: 'buy', propertyType: 'apartment', city: MCITY, localities: ['Sector 9'], budgetMin: 12000000, budgetMax: 16000000, bedrooms: 3,
      urgency: 'immediate', mandateType: 'exclusive', priceRange: { minBudget: 12500000, maxBudget: BUYER_MAX },
      consentToken: await consent(buyer.token, 'requirement'),
    },
  });
  assert.equal(req.status, 201, JSON.stringify(req.body));
  const bmid = req.data.mandate.id;

  // Acknowledgement activates: dates, rep, placement.
  assert.equal((await api('PUT', `/mandates/${mid}/acknowledge`, { token: seller.token })).status, 403);
  const ack = await api('PUT', `/mandates/${mid}/acknowledge`, { token: RM });
  assert.equal(ack.status, 200, JSON.stringify(ack.body));
  assert.equal(ack.data.status, 'active');
  assert.equal(ack.data.assigned_rep_id, ctx.sales.id);
  assert.equal(Math.round((new Date(ack.data.mandate_end_date) - new Date(ack.data.mandate_start_date)) / 86400000), 180);
  assert.equal(ack.data.deed_writer_waiver_status, 'active');
  assert.equal((await pool.query('SELECT mandate_type FROM properties WHERE id = $1', [listing.data.id])).rows[0].mandate_type, 'exclusive');
  const bAck = await api('PUT', `/mandates/${bmid}/acknowledge`, { token: RM });
  assert.equal(Math.round((new Date(bAck.data.mandate_end_date) - new Date(bAck.data.mandate_start_date)) / 86400000), 90);
  const note = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'mandate_active'`, [seller.id]);
  assert.equal(note.rows.length, 1);

  // Price range: assigned rep + Super Admin only, every read logged.
  assert.equal((await api('GET', `/mandates/${mid}/price-range`, { token: A })).status, 403);
  assert.equal((await api('GET', `/mandates/${mid}/price-range`, { token: ctx.broker.token })).status, 403);
  assert.equal((await api('GET', `/mandates/${mid}/price-range`, { token: seller.token })).status, 403);
  const pr = await api('GET', `/mandates/${mid}/price-range`, { token: RM });
  assert.equal(pr.data.minAcceptablePrice, SELLER_MIN);
  assert.equal((await api('GET', `/mandates/${mid}/price-range`, { token: S })).data.maxListedPrice, 15500000);
  const views = await pool.query(`SELECT COUNT(*)::int AS n FROM mandate_events WHERE mandate_id = $1 AND kind = 'price_range_viewed'`, [mid]);
  assert.equal(views.rows[0].n, 2);

  // Price-Compatible match (buyer max >= seller min) - rep-side only.
  await api('PUT', `/properties/${listing.data.id}/approve`, { token: A });
  const buyers = await api('GET', `/matching/listings/${listing.data.id}/buyers`, { token: RM });
  assert.ok(buyers.data.some((b) => b.requirement.id === req.data.id && b.priceCompatible === true), JSON.stringify(buyers.data));

  // No public or client-facing response carries the price range.
  const leaks = [
    await api('GET', `/search/properties/${listing.data.id}`),
    await api('GET', `/properties/${listing.data.id}`, { token: A }),
    await api('GET', `/opportunities/${listing.data.id}`),
    await api('GET', '/me/listings', { token: seller.token }),
    await api('GET', '/me/requirements', { token: buyer.token }),
    await api('GET', '/me/matches', { token: buyer.token }),
    await api('GET', `/mandates/${mid}`, { token: seller.token }),
    await api('GET', `/mandates/${mid}`, { token: S }),
    await api('GET', '/mandates?limit=300', { token: S }),
    await api('GET', '/mandates/mine', { token: buyer.token }),
    await api('GET', `/matching/listings/${listing.data.id}/buyers`, { token: RM }),
  ];
  for (const r of leaks) {
    const text = JSON.stringify(r.body);
    for (const needle of ['seller_min_price', 'seller_max_price', 'buyer_min_budget', 'buyer_max_budget', '_enc', 'min_acceptable', String(SELLER_MIN), String(BUYER_MAX)]) {
      assert.equal(text.includes(needle), false, `response leaked ${needle}: ${text.slice(0, 300)}`);
    }
  }

  // Renewal: needs a deal past Site Visit Completed; cap of 2, then Super Admin.
  assert.equal((await api('POST', `/mandates/${mid}/renew`, { token: RM })).status, 400);
  const sellerCustomer = (await pool.query('SELECT id FROM customers WHERE user_id = $1', [buyer.id])).rows[0].id;
  const deal = (
    await pool.query(
      `INSERT INTO deals (customer_id, broker_id, property_id, stage, deal_value) VALUES ($1, $2, $3, 'negotiation', 15000000) RETURNING id`,
      [sellerCustomer, ctx.broker.id, listing.data.id]
    )
  ).rows[0].id;
  const r1 = await api('POST', `/mandates/${mid}/renew`, { token: RM, body: { reason: 'Negotiation under way' } });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.data.renewal_count, 1);
  assert.equal((await api('POST', `/mandates/${mid}/renew`, { token: RM })).status, 200);
  assert.equal((await api('POST', `/mandates/${mid}/renew`, { token: RM })).status, 403, 'cap reached');
  assert.equal((await api('POST', `/mandates/${mid}/renew`, { token: S })).status, 200, 'Super Admin overrides the cap');
  const renewals = await pool.query(`SELECT pipeline_stage FROM mandate_events WHERE mandate_id = $1 AND kind = 'renewed'`, [mid]);
  assert.equal(renewals.rows.length, 3);
  assert.ok(renewals.rows.every((r) => r.pipeline_stage === 'negotiation'));

  // Deal Detail panel: figures for the assigned rep, 'confidential' for other admins.
  const panel = await api('GET', `/mandates/deal/${deal}`, { token: RM });
  const sellerPanel = panel.data.mandates.find((m) => m.party === 'seller');
  assert.equal(sellerPanel.priceRange.minAcceptablePrice, SELLER_MIN);
  assert.equal(sellerPanel.professionalFeeIndicative.fee, 150000);
  assert.equal(sellerPanel.instalment1.status, 'not_triggered');
  const adminPanel = await api('GET', `/mandates/deal/${deal}`, { token: A });
  assert.ok(adminPanel.data.mandates.every((m) => m.priceRange === 'confidential'));

  // Benefits + client notification.
  const ben = await api('PUT', `/mandates/${mid}/benefits`, { token: RM, body: { valuationStatus: 'report_uploaded' } });
  assert.equal(ben.data.valuation_status, 'report_uploaded');
  assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'mandate_benefit'`, [seller.id])).rows.length);
  assert.equal((await api('PUT', `/mandates/${bmid}/benefits`, { token: RM, body: { valuationStatus: 'requested' } })).status, 400, 'valuation is a seller benefit');

  // Expiry reminders, then expiry withdraws Priority Buyer.
  await pool.query(`UPDATE mandates SET mandate_end_date = current_date + 5 WHERE id = $1`, [bmid]);
  await api('POST', '/mandates/sweep', { token: A });
  const warn = await pool.query(`SELECT detail FROM mandate_events WHERE mandate_id = $1 AND kind = 'expiry_warning'`, [bmid]);
  assert.equal(warn.rows.length, 1);
  await api('POST', '/mandates/sweep', { token: A });
  assert.equal((await pool.query(`SELECT 1 FROM mandate_events WHERE mandate_id = $1 AND kind = 'expiry_warning'`, [bmid])).rows.length, 1, 'no repeat warning');
  await pool.query(`UPDATE mandates SET mandate_end_date = current_date - 1 WHERE id = $1`, [bmid]);
  await api('POST', '/mandates/sweep', { token: A });
  assert.equal((await pool.query('SELECT status FROM mandates WHERE id = $1', [bmid])).rows[0].status, 'expired');
  assert.equal((await pool.query('SELECT mandate_type FROM requirements WHERE id = $1', [req.data.id])).rows[0].mandate_type, 'standard');

  // PDFs for the owner.
  const cpdf = await fetch(`${BASE}/mandates/${mid}/consent-pdf`, { headers: { authorization: `Bearer ${seller.token}` } });
  assert.equal(cpdf.headers.get('content-type'), 'application/pdf');
  const spdf = await fetch(`${BASE}/mandates/${mid}/summary-pdf`, { headers: { authorization: `Bearer ${seller.token}` } });
  assert.equal(spdf.headers.get('content-type'), 'application/pdf');
  assert.equal((await fetch(`${BASE}/mandates/${mid}/summary-pdf`, { headers: { authorization: `Bearer ${buyer.token}` } })).status, 404);

  // Breach withdraws placement; management list + counts.
  assert.equal((await api('POST', `/mandates/${mid}/breach`, { token: RM, body: {} })).status, 422, 'reason required');
  const br = await api('POST', `/mandates/${mid}/breach`, { token: RM, body: { reason: 'Seller sold through another agent' } });
  assert.equal(br.data.status, 'breached');
  assert.equal((await pool.query('SELECT mandate_type FROM properties WHERE id = $1', [listing.data.id])).rows[0].mandate_type, 'standard');
  const mgmt = await api('GET', '/mandates?status=breached', { token: S });
  assert.ok(mgmt.data.items.some((m) => m.id === mid) && mgmt.data.summary.breached >= 1);
  assert.equal((await api('GET', '/mandates', { token: seller.token })).status, 403);

  // Database guards: fee locked at 1%, logs append-only, consents immutable.
  await assert.rejects(pool.query(`UPDATE mandates SET professional_fee_rate_percent = 0.5 WHERE id = $1`, [mid]));
  await assert.rejects(pool.query(`UPDATE mandate_events SET kind = 'x' WHERE mandate_id = $1`, [mid]), /append-only/);
  await assert.rejects(pool.query(`DELETE FROM fee_consents WHERE id = $1`, [stored.fee_consent_id]), /immutable/);
});

test('assignment cascade: rep within the request, DM / mapped RM routing, missed hops to system pool, contact stops it, exit re-injection, SLA, rep shown to parties', async () => {
  const A = ctx.admin.token;
  const ACITY = `Assign City ${RUN}`;
  const mk = async (label, designation, cities, extra = {}) => {
    const u = await createUser('internal_sales', label);
    const r = await api('PUT', `/representatives/${u.id}`, { token: A, body: { designation, platformNumber: `+91 80000 ${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`, assignedCities: cities, ...extra } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return u;
  };
  const dm = await mk('asgdm', 'dm', [ACITY]);
  const rmA = await mk('asgrma', 'rm', [ACITY]);
  const rmB = await mk('asgrmb', 'rm', [ACITY]);
  const far = await mk('asgfar', 'dm', ['Somewhere Else']);
  assert.equal((await api('PUT', `/representatives/${dm.id}`, { token: ctx.sales.token, body: { designation: 'rm' } })).status, 403, 'only admins configure reps');

  // Owner-listed property, guest enquiry -> least-busy DM in the region, inside the request.
  const owner = await createUser('customer', 'asgowner');
  const prop = (await pool.query(
    `INSERT INTO properties (created_by, title, property_type, transaction_type, city, locality, price, status) VALUES ($1, $2, 'apartment', 'sell', $3, 'Block A', '90 Lakh', 'approved') RETURNING id`,
    [owner.id, `Assign flat ${RUN}`, ACITY]
  )).rows[0].id;
  const inq = await api('POST', '/leads/public-inquiry', { body: { fullName: `Guest ${RUN}`, mobile: `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, propertyId: prop } });
  assert.equal(inq.status, 201, JSON.stringify(inq.body));
  const leadId = inq.data.id;
  assert.equal(inq.data.arb_rep_id, dm.id);
  assert.equal(inq.data.assignment_route, 'dm_least_busy');
  assert.ok(inq.data.representative?.platformNumber, 'enquirer sees the rep platform number');
  assert.equal(JSON.stringify(inq.data.representative).includes('@'), false, 'no rep email');
  assert.ok(new Date(inq.data.assigned_at) - new Date(inq.data.created_at) < 60000, 'assigned within 60 seconds');
  assert.ok(inq.data.assignment_due_at);

  // Other reps cannot log contact; DM misses the window -> hop 2 next free RM.
  assert.equal((await api('POST', `/leads/${leadId}/contacted`, { token: rmA.token })).status, 404, 'not visible to other reps');
  await pool.query(`UPDATE leads SET assignment_due_at = now() - interval '1 minute' WHERE id = $1`, [leadId]);
  assert.equal((await api('POST', '/representatives/sweep', { token: A })).status, 200);
  let lead = (await pool.query('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];
  assert.equal(lead.assignment_hop, 2);
  assert.equal(lead.assignment_route, 'next_free');
  assert.ok([rmA.id, rmB.id].includes(lead.arb_rep_id));
  assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'inquiry_missed' AND related_entity_id = $2`, [dm.id, leadId])).rows.length);
  assert.equal((await api('GET', `/leads/${leadId}`, { token: dm.token })).status, 404, 'access follows live ownership');
  const hop2 = lead.arb_rep_id;

  // Miss again -> hop 3 system pool, admins alerted.
  await pool.query(`UPDATE leads SET assignment_due_at = now() - interval '1 minute' WHERE id = $1`, [leadId]);
  await api('POST', '/representatives/sweep', { token: A });
  lead = (await pool.query('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];
  assert.equal(lead.assignment_hop, 3);
  assert.equal(lead.assignment_route, 'system_pool');
  assert.ok(![dm.id, hop2].includes(lead.arb_rep_id), 'never back to someone who missed');
  assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'inquiry_system_pool' AND related_entity_id = $2`, [ctx.admin.id, leadId])).rows.length);
  const trail = await pool.query(`SELECT kind FROM lead_assignment_events WHERE lead_id = $1 ORDER BY created_at`, [leadId]);
  assert.deepEqual(trail.rows.map((r) => r.kind), ['assigned', 'missed', 'transferred', 'missed', 'transferred']);
  await assert.rejects(pool.query(`UPDATE lead_assignment_events SET kind = 'assigned' WHERE lead_id = $1`, [leadId]), /append-only/);

  // The hop-3 rep logs contact -> sticky, no more transfers.
  await pool.query(`UPDATE leads SET arb_rep_id = $2, assigned_to = $2 WHERE id = $1`, [leadId, rmB.id === hop2 ? rmA.id : rmB.id]);
  const holder = rmB.id === hop2 ? rmA : rmB;
  const contacted = await api('POST', `/leads/${leadId}/contacted`, { token: holder.token });
  assert.equal(contacted.status, 200, JSON.stringify(contacted.body));
  await pool.query(`UPDATE leads SET assignment_due_at = now() - interval '1 minute' WHERE id = $1`, [leadId]);
  await api('POST', '/representatives/sweep', { token: A });
  assert.equal((await pool.query('SELECT arb_rep_id FROM leads WHERE id = $1', [leadId])).rows[0].arb_rep_id, holder.id, 'sticky after contact');
  const view = await api('GET', `/leads/${leadId}/assignment`, { token: holder.token });
  assert.ok(view.data.first_contacted_at && view.data.events.some((e) => e.kind === 'contacted'));

  // Brokers: buyer's broker's RM first, then the seller's broker's RM; broker keeps their own queue.
  const buyerBroker = await createUser('broker', 'asgbb');
  const sellerBroker = await createUser('broker', 'asgsb');
  assert.equal((await api('PUT', `/representatives/broker-mappings/${buyerBroker.id}`, { token: A, body: { rmId: rmA.id } })).status, 200);
  assert.equal((await api('PUT', `/representatives/broker-mappings/${sellerBroker.id}`, { token: A, body: { rmId: rmB.id } })).status, 200);
  const bProp = (await pool.query(
    `INSERT INTO properties (created_by, broker_id, title, property_type, transaction_type, city, price, status) VALUES ($1, $1, $2, 'apartment', 'sell', $3, '1 Cr', 'approved') RETURNING id`,
    [sellerBroker.id, `Broker flat ${RUN}`, ACITY]
  )).rows[0].id;
  const cust = (await pool.query(`INSERT INTO customers (full_name, mobile) VALUES ($1, $2) RETURNING id`, [`Broker client ${RUN}`, `97${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`])).rows[0].id;
  const bLead = await api('POST', '/leads', { token: buyerBroker.token, body: { customerId: cust, propertyId: bProp, assignedTo: buyerBroker.id, source: 'manual' } });
  assert.equal(bLead.status, 201, JSON.stringify(bLead.body));
  assert.equal(bLead.data.arb_rep_id, rmA.id);
  assert.equal(bLead.data.assignment_route, 'buyer_broker_rm');
  assert.equal(bLead.data.assigned_to, buyerBroker.id, "broker's own work queue untouched");
  await pool.query(`UPDATE leads SET assignment_due_at = now() - interval '1 minute' WHERE id = $1`, [bLead.data.id]);
  await api('POST', '/representatives/sweep', { token: A });
  const b2 = (await pool.query('SELECT arb_rep_id, assignment_route FROM leads WHERE id = $1', [bLead.data.id])).rows[0];
  assert.deepEqual(b2, { arb_rep_id: rmB.id, assignment_route: 'seller_broker_rm' });

  // Broker status change does not count as A R contact; the rep's does.
  await api('PUT', `/leads/${bLead.data.id}/status`, { token: buyerBroker.token, body: { status: 'qualified' } });
  assert.equal((await pool.query('SELECT first_contacted_at FROM leads WHERE id = $1', [bLead.data.id])).rows[0].first_contacted_at, null);

  // Unmapped broker -> least-busy RM, gap flagged to admins.
  const loneBroker = await createUser('broker', 'asglone');
  const lLead = await api('POST', '/leads', { token: loneBroker.token, body: { customerId: cust, propertyId: prop, source: 'manual' } });
  assert.equal(lLead.data.assignment_route, 'unmapped_broker_rm');
  assert.ok((await pool.query(`SELECT 1 FROM lead_assignment_events WHERE lead_id = $1 AND kind = 'mapping_gap'`, [lLead.data.id])).rows.length);

  // Rep leaves -> their open inquiries re-injected.
  await pool.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [rmB.id]);
  await api('POST', '/representatives/sweep', { token: A });
  const re = (await pool.query('SELECT arb_rep_id FROM leads WHERE id = $1', [bLead.data.id])).rows[0];
  assert.notEqual(re.arb_rep_id, rmB.id);
  assert.ok((await pool.query(`SELECT 1 FROM lead_assignment_events WHERE lead_id = $1 AND kind = 'exit_reinjected' AND from_user_id = $2`, [bLead.data.id, rmB.id])).rows.length);

  // Response SLA breach alert; exclusive-mandate listings get 2 h.
  await pool.query(`UPDATE leads SET response_sla_due_at = now() - interval '1 minute' WHERE id = $1`, [lLead.data.id]);
  await api('POST', '/representatives/sweep', { token: A });
  assert.ok((await pool.query(`SELECT 1 FROM lead_assignment_events WHERE lead_id = $1 AND kind = 'sla_breached'`, [lLead.data.id])).rows.length);
  await pool.query(`UPDATE properties SET mandate_type = 'exclusive' WHERE id = $1`, [prop]);
  const ex = await api('POST', '/leads/public-inquiry', { body: { fullName: `Guest2 ${RUN}`, mobile: `96${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, propertyId: prop } });
  assert.equal(ex.data.response_sla_hours, 2);
  assert.equal(inq.data.response_sla_hours, 24);

  // Rep moving status off New = contact logged; deal follows the rep, who can open it.
  const exRep = (await pool.query('SELECT arb_rep_id FROM leads WHERE id = $1', [ex.data.id])).rows[0].arb_rep_id;
  const exRepUser = [dm, rmA, far].find((u) => u.id === exRep) || null;
  if (exRepUser) {
    await api('PUT', `/leads/${ex.data.id}/status`, { token: exRepUser.token, body: { status: 'contacted' } });
    assert.ok((await pool.query('SELECT first_contacted_at FROM leads WHERE id = $1', [ex.data.id])).rows[0].first_contacted_at);
    const deal = await api('POST', '/deals', { token: A, body: { leadId: ex.data.id, brokerId: ctx.broker.id } });
    assert.equal(deal.status, 201, JSON.stringify(deal.body));
    assert.equal(deal.data.assigned_rep_id, exRep);
    assert.equal((await api('GET', `/deals/${deal.data.id}`, { token: exRepUser.token })).status, 200, 'rep opens the deal');
  }

  // Seller sees the rep (name + number), never the buyer's contact.
  const listingSide = await pool.query(
    `SELECT l.id FROM leads l WHERE l.property_id = $1`, [prop]
  );
  assert.ok(listingSide.rows.length >= 2);
  const reps = await api('GET', '/representatives', { token: A });
  const dmRow = reps.data.find((r) => r.user_id === dm.id);
  assert.equal(dmRow.missed, 1);
  assert.equal(dmRow.designation, 'dm');

  // Working hours: 20:55 IST + 15 min -> 10:10 IST next day.
  const { windowDue } = require('../src/services/assignment.service');
  const due = windowDue(new Date('2026-10-05T15:25:00Z'), 15, { start: '10:00', end: '21:00', timezone_offset_minutes: 330 });
  assert.equal(due.toISOString(), '2026-10-06T04:40:00.000Z');
  void far;
});

test('lead ingestion: self-serve sources, push + pull with idempotency, phone dedupe per org, email parser, review queue, Meta signature, Telegram, immutable tags', async () => {
  const S = ctx.superAdmin.token;
  const A = ctx.admin.token;
  const http = require('http');
  const slug = `ingest-${RUN}`;
  const tenant = (await pool.query(`INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`, [`Ingest Org ${RUN}`, slug])).rows[0].id;
  const other = (await pool.query(`INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`, [`Other Org ${RUN}`, `other-${RUN}`])).rows[0].id;
  const orgAdmin = await createUser('agency_admin', 'ingadmin');
  await pool.query('UPDATE users SET tenant_id = $1 WHERE id = $2', [tenant, orgAdmin.id]);
  const OA = (await api('POST', '/auth/login', { body: { identifier: orgAdmin.email, password: PASSWORD } })).data.accessToken;
  const otherAdmin = await createUser('agency_admin', 'ingother');
  await pool.query('UPDATE users SET tenant_id = $1 WHERE id = $2', [other, otherAdmin.id]);
  const OB = (await api('POST', '/auth/login', { body: { identifier: otherAdmin.email, password: PASSWORD } })).data.accessToken;
  const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

  // Catalogue: every launch source present; brokers can't manage sources.
  const cat = await api('GET', '/lead-sources', { token: OA });
  for (const tag of ['Website-Inquiry', 'WhatsApp-Listing-Inquiry', 'WhatsApp-Requirement', 'Manual-Entry', 'Telegram-Listing-Inquiry', 'Telegram-Requirement',
    'Facebook-Lead-Ad', 'Instagram-Lead-Ad', 'Portal-99acres', 'Portal-MagicBricks', 'Portal-Housing', 'Google-Lead-Form', 'Portal-JustDial', 'Portal-Sulekha']) {
    assert.ok(cat.data.some((s) => s.source_tag === tag), tag);
  }
  assert.equal((await api('GET', '/lead-sources', { token: ctx.broker.token })).status, 403);

  // Org admin connects 99acres themselves - webhook URL encodes their org.
  const conn = await api('PUT', '/lead-sources/connections/99acres', { token: OA, body: { credentials: { api_key: `k-${RUN}` } } });
  assert.equal(conn.status, 200, JSON.stringify(conn.body));
  assert.equal(conn.data.connection.credentials.api_key, `••••${`k-${RUN}`.slice(-4)}`, 'credentials masked');
  const url99 = new URL(conn.data.connection.webhookUrl).pathname.replace(/^\/api/, '');
  const stored = (await pool.query(`SELECT credentials_enc FROM lead_source_connections WHERE id = $1`, [conn.data.connection.id])).rows[0];
  assert.match(stored.credentials_enc, /^v1:/);

  const p1 = phone();
  const lead1 = { lead_id: `A-${RUN}-1`, name: 'Portal Buyer', mobile: `+91 ${p1}`, city: 'Gurugram', locality: 'Sector 65', budget: '1.2 Cr', property_type: '3 BHK Apartment', message: 'Interested in project' };
  assert.equal((await api('POST', url99, { body: lead1 })).status, 403, 'api key required');
  const push = await api('POST', url99, { body: lead1, headers: { 'x-api-key': `k-${RUN}` } });
  assert.equal(push.status, 200, JSON.stringify(push.body));
  assert.equal(push.data.results[0].status, 'lead_created');
  const L1 = push.data.results[0].leadId;
  const row1 = (await pool.query('SELECT tenant_id, source::text, source_tag, ingestion_mode, external_lead_id, arb_rep_id FROM leads WHERE id = $1', [L1])).rows[0];
  assert.deepEqual({ ...row1, arb_rep_id: undefined }, { tenant_id: tenant, source: 'portal', source_tag: 'Portal-99acres', ingestion_mode: 'push', external_lead_id: `A-${RUN}-1`, arb_rep_id: undefined });
  assert.ok(row1.arb_rep_id, 'assignment cascade ran');

  // Same external id again (retry / pull) -> processed once.
  const again = await api('POST', url99, { body: lead1, headers: { 'x-api-key': `k-${RUN}` } });
  assert.equal(again.data.results[0].dedup, 'duplicate_external_id');
  // Same phone, new enquiry -> no second lead, both sources kept.
  const dupe = await api('POST', url99, { body: { ...lead1, lead_id: `A-${RUN}-2` }, headers: { 'x-api-key': `k-${RUN}` } });
  assert.equal(dupe.data.results[0].dedup, 'duplicate_same_org');
  assert.equal(dupe.data.results[0].leadId, L1);
  const hist = await api('GET', `/leads/${L1}/sources`, { token: S });
  assert.equal(hist.data.length, 2);
  await assert.rejects(pool.query(`UPDATE leads SET source_tag = 'Manual-Entry' WHERE id = $1`, [L1]), /immutable/);
  await assert.rejects(pool.query(`DELETE FROM lead_source_history WHERE lead_id = $1`, [L1]), /append-only/);

  // Google Ads lead form for A R Buildwel: google_key checked; same phone in another org = new lead.
  const g = await api('PUT', '/lead-sources/connections/google', { token: A, body: { tenantId: 'arb' } });
  const gKey = new URL(g.data.connection.webhookUrl).pathname.split('/').pop();
  const gBody = { lead_id: `G-${RUN}`, google_key: 'wrong', user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Google Lead' }, { column_id: 'PHONE_NUMBER', string_value: `+91${p1}` }, { column_id: 'CITY', string_value: 'Noida' }] };
  assert.equal((await api('POST', `/leads/ingest/google/${gKey}`, { body: gBody })).status, 403);
  const gOk = await api('POST', `/leads/ingest/google/${gKey}`, { body: { ...gBody, google_key: gKey } });
  assert.equal(gOk.data.results[0].status, 'lead_created');
  assert.equal(gOk.data.results[0].dedup, 'duplicate_cross_org');
  assert.equal((await pool.query('SELECT tenant_id, source_tag FROM leads WHERE id = $1', [gOk.data.results[0].leadId])).rows[0].source_tag, 'Google-Lead-Form');

  // JustDial posts form-encoded fields with its own names (field mapping row).
  const jd = await api('PUT', '/lead-sources/connections/justdial', { token: OA, body: { credentials: {} } });
  const jdPath = new URL(jd.data.connection.webhookUrl).pathname;
  const jdRes = await fetch(`${BASE.replace(/\/api$/, '')}${jdPath}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ leadid: `JD-${RUN}`, custname: 'JD Caller', custmobile: phone(), city: 'Delhi', area: 'Rajouri Garden', category: 'Flats for rent' }),
  });
  const jdJson = await jdRes.json();
  assert.equal(jdJson.data.results[0].status, 'lead_created', JSON.stringify(jdJson));

  // Unreadable payload -> review queue -> admin completes it.
  const bad = await api('POST', url99, { body: { lead_id: `A-${RUN}-bad`, name: 'No Contact' }, headers: { 'x-api-key': `k-${RUN}` } });
  assert.equal(bad.data.results[0].status, 'parse_failed');
  assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'lead_ingestion_review'`, [orgAdmin.id])).rows.length);
  const queue = await api('GET', '/lead-sources/inbox?status=parse_failed', { token: OA });
  assert.ok(queue.data.items.some((i) => i.id === bad.data.results[0].inboxId));
  assert.equal((await api('GET', `/lead-sources/inbox/${bad.data.results[0].inboxId}`, { token: OB })).status, 404, 'other org cannot see it');
  const fixed = await api('POST', `/lead-sources/inbox/${bad.data.results[0].inboxId}/resolve`, { token: OA, body: { phone: phone(), city: 'Gurugram' } });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.ok(fixed.data.created);

  // Portal email to the org's mailbox, sender domain picks the source.
  const box = (await api('GET', '/lead-sources/connections', { token: OA })).data.mailbox;
  assert.equal(box, `lead-${slug}@leads.propertyserch.com`);
  assert.equal((await api('POST', '/leads/ingest/email', { body: { to: box, from: 'x@y.com', subject: 'x', text: 'x' } })).status, 403);
  const em = await api('POST', '/leads/ingest/email', {
    headers: { 'x-ingest-secret': process.env.LEAD_EMAIL_INGEST_SECRET },
    body: {
      to: box, from: 'Leads <alerts@99acres.com>', subject: 'New response for your property in Sector 56',
      text: `Dear Advertiser,\nName: Email Buyer\nMobile: ${phone()}\nEmail: buyer.${RUN}@mail.test\nLocation: Sector 56, Gurugram\nBudget: 85 Lakh\nProperty Type: 2 BHK Apartment\nLead Id: EM-${RUN}`,
    },
  });
  assert.equal(em.status, 200, JSON.stringify(em.body));
  assert.equal(em.data.status, 'lead_created');
  const emLead = (await pool.query('SELECT tenant_id, source_tag FROM leads WHERE id = $1', [em.data.leadId])).rows[0];
  assert.deepEqual(emLead, { tenant_id: tenant, source_tag: 'Portal-99acres' });

  // Meta Lead Ads webhook: routed by page id, signature checked.
  const crypto = require('crypto');
  const page = `PAGE${RUN}`;
  await api('PUT', '/lead-sources/connections/facebook', { token: OA, body: { credentials: { page_id: page, app_secret: 'shh', verify_token: `vt-${RUN}` } } });
  const verify = await fetch(`${BASE}/leads/ingest/meta?hub.mode=subscribe&hub.verify_token=vt-${RUN}&hub.challenge=4242`);
  assert.equal(await verify.text(), '4242');
  const metaBody = { object: 'page', entry: [{ id: page, changes: [{ field: 'leadgen', value: { page_id: page, leadgen_id: `FB-${RUN}`, field_data: [{ name: 'full_name', values: ['FB Lead'] }, { name: 'phone_number', values: [phone()] }, { name: 'city', values: ['Delhi'] }] } }] }] };
  const raw = JSON.stringify(metaBody);
  const badSig = await fetch(`${BASE}/leads/ingest/meta`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, body: raw });
  assert.equal(badSig.status, 403);
  const okSig = await fetch(`${BASE}/leads/ingest/meta`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', 'shh').update(raw).digest('hex')}` }, body: raw });
  const metaJson = await okSig.json();
  assert.equal(metaJson.data.results[0].status, 'lead_created', JSON.stringify(metaJson));
  assert.equal((await pool.query('SELECT source_tag FROM leads WHERE id = $1', [metaJson.data.results[0].leadId])).rows[0].source_tag, 'Facebook-Lead-Ad');

  // Pull reconciliation from a portal's lead API (mock server); idempotent.
  const pulled = [{ enquiry_id: `H-${RUN}-1`, customer_name: 'Pull One', phone_number: phone(), city: 'Pune' }, { enquiry_id: `H-${RUN}-2`, customer_name: 'Pull Two', phone_number: phone(), city: 'Pune' }];
  let sinceSeen = null;
  const mock = http.createServer((req, res) => {
    sinceSeen = new URL(req.url, 'http://x').searchParams.get('since');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ leads: pulled }));
  });
  await new Promise((r) => mock.listen(0, r));
  const hc = await api('PUT', '/lead-sources/connections/housing', { token: OA, body: { credentials: { pull_url: `http://127.0.0.1:${mock.address().port}/leads` } } });
  const p1r = await api('POST', `/lead-sources/connections/${hc.data.connection.id}/pull`, { token: OA });
  assert.deepEqual(p1r.data, { fetched: 2, created: 2, duplicates: 0 });
  assert.ok(sinceSeen);
  const p2r = await api('POST', `/lead-sources/connections/${hc.data.connection.id}/pull`, { token: OA });
  assert.deepEqual(p2r.data, { fetched: 2, created: 0, duplicates: 2 });
  assert.equal((await pool.query(`SELECT ingestion_mode FROM leads WHERE external_lead_id = $1`, [`H-${RUN}-1`])).rows[0].ingestion_mode, 'pull');
  mock.close();
  // Repeated pull failure -> flagged to Super Admin and the org admin.
  const port = mock.address()?.port || 1;
  await api('PUT', '/lead-sources/connections/housing', { token: OA, body: { credentials: { pull_url: `http://127.0.0.1:${port}/gone` } } });
  for (let i = 0; i < 3; i += 1) await api('POST', `/lead-sources/connections/${hc.data.connection.id}/pull`, { token: OA });
  assert.equal((await pool.query('SELECT status FROM lead_source_connections WHERE id = $1', [hc.data.connection.id])).rows[0].status, 'error');
  assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'lead_source_failing'`, [orgAdmin.id])).rows.length);

  // New source added by Super Admin - no code: works through the generic webhook.
  assert.equal((await api('POST', '/lead-sources', { token: A, body: { sourceKey: `cf_${RUN}`, sourceName: 'CommonFloor', sourceTag: `Portal-CF-${RUN}` } })).status, 403);
  const ns = await api('POST', '/lead-sources', { token: S, body: { sourceKey: `cf_${RUN}`, sourceName: 'CommonFloor', sourceTag: `Portal-CF-${RUN}`, channel: 'portal', normaliserModule: 'portal', fieldMapping: { phone: ['cust_ph'] } } });
  assert.equal(ns.status, 201, JSON.stringify(ns.body));
  const nc = await api('PUT', `/lead-sources/connections/cf_${RUN}`, { token: OA, body: { credentials: {} } });
  const nres = await api('POST', new URL(nc.data.connection.webhookUrl).pathname.replace(/^\/api/, ''), { body: { name: 'CF Lead', cust_ph: phone(), city: 'Delhi' } });
  assert.equal(nres.data.results[0].status, 'lead_created');
  await assert.rejects(pool.query(`UPDATE lead_sources SET source_tag = 'X' WHERE source_key = $1`, [`cf_${RUN}`]), /immutable/);
  const master = await api('GET', '/lead-sources/master', { token: S });
  assert.ok(master.data.some((m) => m.source_key === '99acres' && m.tenant_id === tenant && m.leads_this_month >= 1));

  // Website enquiries carry their tag + first history row too.
  const web = await api('POST', '/leads/public-inquiry', { body: { fullName: `Web ${RUN}`, mobile: phone() } });
  assert.equal(web.data.source_tag, 'Website-Inquiry');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM lead_source_history WHERE lead_id = $1', [web.data.id])).rows[0].n, 1);

  // Telegram: secret header, requirement flow, listing deep link.
  const tg = (u) => fetch(`${BASE}/telegram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET }, body: JSON.stringify(u) }).then((r) => r.json());
  assert.equal((await fetch(`${BASE}/telegram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const chat = Number(`7${parseInt(RUN, 16)}`);
  const msg = (text) => ({ message: { chat: { id: chat }, text } });
  const tap = (data) => ({ callback_query: { id: 'cb', data, message: { chat: { id: chat } } } });
  await tg(msg('/start'));
  await tg(tap('purpose:buy'));
  await tg(msg('Sector 50, Noida'));
  await tg(tap('budget:1 cr - 2 cr'));
  await tg(tap('propertyType:apartment'));
  await tg(msg('Tele Buyer'));
  const tgPhone = phone();
  const done = await tg({ message: { chat: { id: chat }, contact: { phone_number: `+91${tgPhone}` } } });
  assert.equal(done.data.completed, true, JSON.stringify(done));
  const tlead = (await pool.query('SELECT source::text, source_tag FROM leads WHERE id = $1', [done.data.leadId])).rows[0];
  assert.deepEqual(tlead, { source: 'telegram', source_tag: 'Telegram-Requirement' });
  const listing = (await pool.query(`SELECT id FROM properties WHERE status = 'approved' ORDER BY created_at DESC LIMIT 1`)).rows[0].id;
  const chat2 = chat + 1;
  const m2 = (text) => ({ message: { chat: { id: chat2 }, text } });
  await tg(m2(`/start p_${listing}`));
  await tg(m2('Listing Asker'));
  const d2 = await tg(m2(phone()));
  assert.equal(d2.data.completed, true, JSON.stringify(d2));
  const l2 = (await pool.query('SELECT source_tag, property_id FROM leads WHERE id = $1', [d2.data.leadId])).rows[0];
  assert.deepEqual(l2, { source_tag: 'Telegram-Listing-Inquiry', property_id: listing });

  // Org isolation for connections.
  const otherView = await api('GET', '/lead-sources/connections', { token: OB });
  assert.ok(!otherView.data.items.find((i) => i.source.key === '99acres').connection, "other org doesn't see this org's connection");
});

test('guest interest (OTP, no account), web push, reference-data crawlers (RERA / price index / market stats), OCR notices', async (t) => {
  const http = require('http');
  const nodeCrypto = require('crypto');
  const { Jimp, loadFont } = require('jimp');
  const fonts = require('jimp/fonts');
  const { PDFDocument } = require('pdf-lib');
  const A = ctx.admin.token;
  const S = ctx.sales.token;
  const GCITY = `Guest City ${RUN}`;

  // ------------------------------------------------------------ guest interest
  const lister = await createUser('broker', 'guestLister');
  const listing = await api('POST', '/properties', { token: lister.token, body: { ...baseListing(), title: `Guest flat ${RUN}`, city: GCITY, locality: 'Gamma Enclave', price: '90 Lakh', reraNumber: `P${RUN}00123` } });
  const P = listing.data.id;
  await pool.query(`UPDATE properties SET status = 'approved', under_review = false, rera_number = $2, area_sqft = 1000 WHERE id = $1`, [P, `P-${RUN}-00123`]);
  const mobile = `8${String(parseInt(RUN, 16) % 1e9).padStart(9, '0')}`;

  assert.equal((await api('POST', '/guest/interest/otp', { body: { mobile: '1234567890' } })).status, 400);
  const otp1 = await api('POST', '/guest/interest/otp', { body: { mobile: `+91 ${mobile}` } });
  assert.equal(otp1.status, 200, JSON.stringify(otp1.body));
  assert.equal(otp1.data.mobile, mobile);
  assert.equal((await api('POST', '/guest/interest', { body: { mobile, otp: '000000', propertyId: P } })).status, 400, 'wrong OTP');
  assert.equal((await api('POST', '/guest/interest', { body: { mobile, otp: otp1.data.otp } })).status, 400, 'needs a listing or requirement');
  const interest = await api('POST', '/guest/interest', { body: { mobile, otp: otp1.data.otp, fullName: `Guest ${RUN}`, propertyId: P, message: 'Is it still available?', anonymousId: `anon-${RUN}` } });
  assert.equal(interest.status, 201, JSON.stringify(interest.body));
  assert.match(interest.data.reference, /^GI-[0-9A-F]{8}$/);
  assert.ok('representative' in interest.data);
  assert.deepEqual(Object.keys(interest.data).sort(), ['alreadyRegistered', 'message', 'reference', 'representative'], 'guest sees only a reference and the representative');
  const cust = (await pool.query('SELECT id, user_id FROM customers WHERE mobile = $1', [mobile])).rows[0];
  assert.ok(cust && cust.user_id === null, 'lead tied to the phone, no account');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE mobile = $1', [mobile])).rows[0].n, 0);
  const leads = () => pool.query('SELECT id, property_id, source FROM leads WHERE customer_id = $1', [cust.id]).then((r) => r.rows);
  assert.equal((await leads()).length, 1);
  assert.equal((await leads())[0].property_id, P);
  assert.ok((await pool.query(`SELECT 1 FROM lead_notes WHERE lead_id = $1 AND note LIKE '%Guest interest (mobile verified by OTP)%'`, [(await leads())[0].id])).rows.length);
  assert.equal((await api('POST', '/guest/interest', { body: { mobile, otp: otp1.data.otp, propertyId: P } })).status, 400, 'an OTP works once');

  // Same guest, same listing -> same lead, not a duplicate.
  const otp2 = await api('POST', '/guest/interest/otp', { body: { mobile } });
  const repeat = await api('POST', '/guest/interest', { body: { mobile, otp: otp2.data.otp, propertyId: P } });
  assert.equal(repeat.data.alreadyRegistered, true);
  assert.equal((await leads()).length, 1);

  // Posted requirements: masked browse + interest.
  const reqOwner = await createUser('customer', 'guestReqOwner');
  await api('GET', '/me/profile', { token: reqOwner.token });
  const reqCust = (await pool.query('SELECT id FROM customers WHERE user_id = $1', [reqOwner.id])).rows[0].id;
  const R = (await pool.query(
    `INSERT INTO requirements (customer_id, created_by, purpose, property_type, city, localities, budget_min, budget_max, status, fee_consent_at)
     VALUES ($1, $2, 'buy', 'apartment', $3, '["Gamma Enclave"]', 5000000, 9000000, 'active', now()) RETURNING id`,
    [reqCust, reqOwner.id, GCITY]
  )).rows[0].id;
  const browse = await api('GET', `/guest/requirements?city=${encodeURIComponent(GCITY)}`);
  const seen = browse.data.find((r) => r.id === R);
  assert.ok(seen && seen.localities[0] === 'Gamma Enclave');
  assert.ok(!/budget|customer|mobile|email|name/i.test(Object.keys(seen).join(',')), 'area and locality only');
  const otp3 = await api('POST', '/guest/interest/otp', { body: { mobile } });
  const reqInterest = await api('POST', '/guest/interest', { body: { mobile, otp: otp3.data.otp, requirementId: R } });
  assert.equal(reqInterest.status, 201);
  assert.equal((await leads()).length, 2);

  // Registering later with the same mobile attaches everything - nothing lost or duplicated.
  const reg = await api('POST', '/auth/register', { body: { fullName: `Guest ${RUN}`, email: `guest.${RUN}@e2e.test`, mobile, password: PASSWORD, role: 'customer' } });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const linked = (await pool.query('SELECT id, user_id FROM customers WHERE mobile = $1', [mobile])).rows;
  assert.equal(linked.length, 1);
  assert.equal(linked[0].id, cust.id);
  assert.ok(linked[0].user_id, 'customer record now belongs to the new account');
  assert.equal((await leads()).length, 2);

  // ------------------------------------------------------------ fixture server (push service + portals)
  const received = [];
  let pushStatus = 201;
  const scan = async (lines) => {
    const img = new Jimp({ width: 1100, height: 80 + lines.length * 70, color: 0xffffffff });
    const font = await loadFont(fonts.SANS_32_BLACK);
    lines.forEach((text, i) => img.print({ font, x: 30, y: 30 + i * 70, text }));
    return img;
  };
  const scannedPdf = async (lines) => {
    const pdf = await PDFDocument.create();
    const jpg = await pdf.embedJpg(await (await scan(lines)).getBuffer('image/jpeg'));
    pdf.addPage([jpg.width, jpg.height]).drawImage(jpg, { x: 0, y: 0, width: jpg.width, height: jpg.height });
    return Buffer.from(await pdf.save());
  };
  // City names unique per run, in letters OCR reads reliably.
  const word = [...RUN].map((c) => 'abdeghkmnoprstuw'[parseInt(c, 16)]).join('');
  const INDEX_CITY = `Index${word}`;
  const INDEX_CITY_2 = `Other${word}`;
  const indexPdf = await scannedPdf(['RBI House Price Index Q1 2025-26', `${INDEX_CITY} 312.4 4.2 1.1`, `${INDEX_CITY_2} 287.0 3.5 0.8`]);
  const RERA_NO = `P-${RUN}-00123`;
  const port = 5000 + Math.floor(Math.random() * 400) + 5800;
  const server = http
    .createServer((req, res) => {
      if (req.url === '/robots.txt') return res.end('User-agent: *\nAllow: /\n');
      if (req.url.startsWith('/push/')) {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          received.push({ headers: req.headers, body: Buffer.concat(chunks) });
          res.statusCode = pushStatus;
          res.end();
        });
        return undefined;
      }
      if (req.url === '/rera') {
        return res.end(`<table>
          <tr class="p"><td class="no">${RERA_NO}</td><td class="name">Sunrise Heights ${RUN}</td><td class="promoter">ABC Developers ${RUN}</td><td class="city">${GCITY}</td><td class="status">Registered</td><td class="units">240</td><td class="complaints">7</td><td class="due">31-03-2024</td></tr>
          <tr class="p"><td class="no">P-${RUN}-00999</td><td class="name">Lake View ${RUN}</td><td class="promoter">XYZ Infra ${RUN}</td><td class="city">${GCITY}</td><td class="status">Completed</td><td class="units">80</td><td class="complaints">0</td><td class="due">01-01-2023</td></tr>
          <tr class="p"><td class="no"></td><td class="name">No number</td></tr></table>`);
      }
      if (req.url === '/market') {
        return res.end(`<table>
          <tr class="a"><td class="loc">Gamma Enclave</td><td class="avg">Rs. 12,000</td><td class="chg">6.5%</td><td class="supply">140</td></tr>
          <tr class="a"><td class="loc">3 BHK for sale call 9876543210</td><td class="avg">Rs. 9,000</td><td class="chg">1%</td><td class="supply">1</td></tr>
          <tr class="a"><td class="loc"></td><td class="avg">Rs. 10,500</td><td class="chg">5.0%</td><td class="supply">900</td></tr></table>`);
      }
      if (req.url === '/market2') return res.end(`<table><tr class="a"><td class="loc">Gamma Enclave</td><td class="avg">Rs. 14,000</td><td class="chg">7.5%</td><td class="supply">60</td></tr></table>`);
      if (req.url === '/indices') return res.end('<a href="/hpi.pdf">HPI</a>');
      if (req.url === '/hpi.pdf') {
        res.setHeader('content-type', 'application/pdf');
        return res.end(indexPdf);
      }
      res.statusCode = 404;
      return res.end();
    })
    .listen(port);
  const base = `http://localhost:${port}`;
  const sources = (await api('GET', '/crawlers/sources', { token: A })).data;
  const src = (key) => sources.find((s) => s.source_key === key);
  const touched = ['rera_maharera', 'portal_99acres', 'portal_magicbricks', 'rbi_hpi'].map((k) => src(k));
  try {
    // ---------------------------------------------------------- web push
    const pushInfo = await api('GET', '/notifications/push', { token: ctx.customer.token });
    assert.equal(pushInfo.status, 200);
    if (!pushInfo.data.configured) {
      t.diagnostic('VAPID keys not set on the server - web push delivery not exercised');
    } else {
      const ua = nodeCrypto.createECDH('prime256v1');
      const uaPublic = ua.generateKeys();
      const authSecret = nodeCrypto.randomBytes(16);
      const sub = { endpoint: `${base}/push/${RUN}`, keys: { p256dh: uaPublic.toString('base64url'), auth: authSecret.toString('base64url') } };
      assert.equal((await api('POST', '/notifications/push', { token: ctx.customer.token, body: { ...sub, endpoint: 'https://evil.example.com/x' } })).status, 400, 'only real push services');
      assert.equal((await api('POST', '/notifications/push', { token: ctx.customer.token, body: sub })).status, 201);
      const sent = await api('POST', '/notifications/push/test', { token: ctx.customer.token });
      assert.equal(sent.data.sent, 1);
      const msg = received.pop();
      assert.match(msg.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
      assert.equal(msg.headers['content-encoding'], 'aes128gcm');
      // Decrypt as the browser would (RFC 8291).
      const salt = msg.body.subarray(0, 16);
      const keyLen = msg.body.readUInt8(20);
      const asPublic = msg.body.subarray(21, 21 + keyLen);
      const cipherText = msg.body.subarray(21 + keyLen);
      const ikm = Buffer.from(nodeCrypto.hkdfSync('sha256', ua.computeSecret(asPublic), authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
      const cek = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const decipher = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(cipherText.subarray(cipherText.length - 16));
      const plain = Buffer.concat([decipher.update(cipherText.subarray(0, cipherText.length - 16)), decipher.final()]);
      const payload = JSON.parse(plain.subarray(0, plain.length - 1).toString());
      assert.equal(payload.title, 'PropertySerch');
      assert.equal(payload.url, '/dashboard/notifications');
      // Every in-app notification is pushed too.
      await require('../src/services/notification.service'); // (server process does the push; trigger one through the API)
      pushStatus = 410; // browser unsubscribed -> subscription removed
      const gone = await api('POST', '/notifications/push/test', { token: ctx.customer.token });
      assert.equal(gone.data.removed, 1);
      assert.equal((await api('GET', '/notifications/push', { token: ctx.customer.token })).data.subscriptions, 0);
    }

    // ---------------------------------------------------------- RERA registry
    for (const s of touched) {
      await api('PUT', `/crawlers/sources/${s.id}/legal-approval`, { token: A, body: { approved: false } });
      await api('POST', `/crawlers/sources/${s.id}/reset`, { token: A });
    }
    const rera = src('rera_maharera');
    assert.equal(rera.output, 'rera_projects');
    await api('PUT', `/crawlers/sources/${rera.id}`, {
      token: A,
      body: { listUrl: `${base}/rera`, adapter: 'html_list', config: { itemSelector: 'tr.p', constants: { state: 'Maharashtra' }, fields: { rera_number: 'td.no', project_name: 'td.name', promoter_name: 'td.promoter', city: 'td.city', project_status: 'td.status', approved_units: 'td.units', complaints_count: 'td.complaints', proposed_completion_date: 'td.due' } } },
    });
    const dry = await api('POST', `/crawlers/sources/${rera.id}/run?mode=test`, { token: A });
    assert.equal(dry.data.output, 'rera_projects');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM rera_projects WHERE rera_number = $1', [RERA_NO])).rows[0].n, 0, 'test run stores nothing');
    assert.equal((await api('POST', `/crawlers/sources/${rera.id}/run`, { token: A })).status, 400, 'legal approval gate applies');
    await api('PUT', `/crawlers/sources/${rera.id}/legal-approval`, { token: A, body: { approved: true, notes: 'e2e' } });
    const reraRun = await api('POST', `/crawlers/sources/${rera.id}/run`, { token: A });
    assert.equal(reraRun.status, 200, JSON.stringify(reraRun.body));
    assert.equal(reraRun.data.summary.stored, 2);
    assert.equal(reraRun.data.summary.rejected, 1, 'row without a RERA number rejected');
    assert.equal((await api('POST', `/crawlers/sources/${rera.id}/run`, { token: A })).data.summary.updated, 2, 're-crawl updates, no duplicates');
    const lookup = await api('GET', `/market/rera/${encodeURIComponent(RERA_NO.toLowerCase())}`);
    assert.equal(lookup.data.found, true);
    assert.equal(lookup.data.project.status, 'delayed', 'past its completion date and not completed');
    assert.equal(lookup.data.project.approvedUnits, 240);
    assert.ok(lookup.data.flags.some((f) => /delayed/.test(f.detail)) && lookup.data.flags.some((f) => /7 complaints/.test(f.detail)));
    // Due-diligence enrichment on the listing that carries this RERA number.
    const dd = await api('GET', `/due-diligence/properties/${P}`, { token: S });
    assert.equal(dd.data.rera.found, true);
    assert.ok(dd.data.riskFlags.some((f) => f.source === 'rera_registry' && /delayed/.test(f.detail)));
    assert.ok((await api('GET', `/market/rera?q=${encodeURIComponent(`Sunrise Heights ${RUN}`)}`, { token: S })).data.length === 1);

    // ---------------------------------------------------------- portal market stats (aggregates only)
    const mk = (key, path) => ({ id: src(key).id, body: { listUrl: `${base}${path}`, adapter: 'html_list', config: { itemSelector: 'tr.a', constants: { city: GCITY }, fields: { locality: 'td.loc', avg_price_per_sqft: 'td.avg', price_change_percent: 'td.chg', supply_count: 'td.supply' } } } });
    for (const m of [mk('portal_99acres', '/market'), mk('portal_magicbricks', '/market2')]) {
      await api('PUT', `/crawlers/sources/${m.id}`, { token: A, body: m.body });
      await api('PUT', `/crawlers/sources/${m.id}/legal-approval`, { token: A, body: { approved: true, notes: 'e2e ToS reviewed' } });
    }
    const m1 = await api('POST', `/crawlers/sources/${src('portal_99acres').id}/run`, { token: A });
    assert.equal(m1.data.summary.stored, 2, JSON.stringify(m1.body));
    assert.equal(m1.data.summary.rejected, 1, 'listing-like row with a phone number rejected');
    await api('POST', `/crawlers/sources/${src('portal_magicbricks').id}/run`, { token: A });
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM market_stats WHERE city = $1 AND locality ~ '[0-9]{6,}'`, [GCITY])).rows[0].n, 0);
    const bench = await api('GET', `/market/benchmarks?city=${encodeURIComponent(GCITY)}&locality=Gamma%20Enclave`);
    assert.equal(bench.data.scope, 'locality');
    assert.equal(bench.data.avgPricePerSqft, 13000, 'mean of the two portals');
    assert.equal(bench.data.sources, 2);
    assert.match(bench.data.disclaimer, /verify independently/);
    assert.ok(!('portals' in bench.data) && !/99acres|magicbricks/i.test(JSON.stringify(bench.data)), 'portal never attributed publicly');
    const cityBench = await api('GET', `/market/benchmarks?city=${encodeURIComponent(GCITY)}&locality=Unknown%20Area`);
    assert.equal(cityBench.data.scope, 'city');
    assert.equal(cityBench.data.avgPricePerSqft, 10500);
    // Engine 6: the benchmark stands in for a missing market value when scoring.
    const prop = (await pool.query('SELECT * FROM properties WHERE id = $1', [P])).rows[0];
    require('../src/services/market.service').clearCache();
    const scored = await require('../src/services/opportunityScoring.service').scoreOpportunity(prop);
    assert.equal(scored.breakdown.inputs.estimatedMarketValue, 13000000);
    assert.equal(scored.breakdown.inputs.marketValueSource, 'market_benchmark_locality');

    // ---------------------------------------------------------- price index from a scanned PDF (OCR)
    const hpi = src('rbi_hpi');
    await api('PUT', `/crawlers/sources/${hpi.id}`, { token: A, body: { listUrl: `${base}/indices`, adapter: 'pdf_links', config: { constants: { index_source: 'rbi_hpi' } } } });
    await api('PUT', `/crawlers/sources/${hpi.id}/legal-approval`, { token: A, body: { approved: true, notes: 'e2e' } });
    const hpiRun = await api('POST', `/crawlers/sources/${hpi.id}/run`, { token: A });
    assert.equal(hpiRun.status, 200, JSON.stringify(hpiRun.body));
    assert.ok(hpiRun.data.ocrPages >= 1, 'scanned PDF went through OCR');
    assert.equal(hpiRun.data.summary.stored, 2, JSON.stringify(hpiRun.data));
    const idx = (await pool.query(`SELECT * FROM price_indices WHERE lower(city) = lower($1) AND index_source = 'rbi_hpi'`, [INDEX_CITY])).rows[0];
    assert.ok(idx, `index row for ${INDEX_CITY}: ${JSON.stringify(hpiRun.data.sample)}`);
    assert.equal(Number(idx.index_value), 312.4);
    assert.equal(Number(idx.yoy_change_percent), 4.2);
    assert.equal(idx.period, 'FY26-Q1');
    const overview = await api('GET', '/market/overview', { token: S });
    assert.ok(overview.data.counts.rera_projects >= 2 && overview.data.counts.price_indices >= 2 && overview.data.counts.market_stats >= 3);
    assert.ok(overview.data.promotersToWatch.some((p) => p.promoter_name === `ABC Developers ${RUN}`));
    assert.equal((await api('GET', '/market/overview', { token: lister.token })).status, 403);

    // ---------------------------------------------------------- OCR: scanned notice upload
    const noticeImg = await (await scan(['E-AUCTION SALE NOTICE under SARFAESI Act', `Flat in ${INDEX_CITY}`, 'Reserve Price: Rs. 45,00,000', 'EMD: Rs. 4,50,000', 'Date of e-Auction: 12-11-2027', 'Contact 9876543210'])).getBuffer('image/png');
    const fd = new FormData();
    fd.append('file', new Blob([noticeImg], { type: 'image/png' }), 'notice.png');
    fd.append('sourceName', `E2E scanned notice ${RUN}`);
    const parsed = await fetch(`${BASE}/crawlers/parse-notice`, { method: 'POST', headers: { authorization: `Bearer ${A}` }, body: fd }).then((r) => r.json());
    assert.equal(parsed.data.reader.method, 'tesseract', JSON.stringify(parsed));
    assert.equal(parsed.data.parsed.reserve_price, 4500000);
    assert.equal(parsed.data.parsed.emd_amount, 450000);
    const item = await api('GET', `/opportunities/ingest/${parsed.data.summary.items[0].id}`, { token: A });
    assert.ok(!JSON.stringify(item.data.normalised).includes('9876543210'), 'contact numbers never stored');
    // Scanned (image-only) PDF notice.
    const fd2 = new FormData();
    fd2.append('file', new Blob([await scannedPdf(['SALE NOTICE', 'Reserve Price: Rs. 62,00,000', 'Date of e-Auction: 20-12-2027'])], { type: 'application/pdf' }), 'scan.pdf');
    const parsedPdf = await fetch(`${BASE}/crawlers/parse-notice`, { method: 'POST', headers: { authorization: `Bearer ${A}` }, body: fd2 }).then((r) => r.json());
    assert.equal(parsedPdf.data.parsed.reserve_price, 6200000, JSON.stringify(parsedPdf));
    assert.equal(parsedPdf.data.reader.ocrPages, 1);

    // sitemap carries the new public pages.
    const sitemap = await fetch(`${BASE}/content/sitemap.xml`).then((r) => r.text());
    assert.ok(['/about', '/pricing', '/for-brokers', '/partner-with-us'].every((p) => sitemap.includes(`${p}</loc>`)));
  } finally {
    for (const s of touched) {
      await api('PUT', `/crawlers/sources/${s.id}/legal-approval`, { token: A, body: { approved: false } });
      await api('PUT', `/crawlers/sources/${s.id}`, { token: A, body: { listUrl: null } }).catch(() => {});
    }
    server.close();
  }
});

test('UAT round 1: role-scoped dashboard, enquiry desk by type, site-visit requests, attention counts, reviews on the listing, testimonials, notification preferences', async () => {
  const A = ctx.admin.token;
  const S = ctx.sales.token;
  const UCITY = `Uat City ${RUN}`;
  const lister = await createUser('broker', 'uatLister');
  const outsider = await createUser('broker', 'uatOutsider');
  const listing = await api('POST', '/properties', { token: lister.token, body: { ...baseListing(), title: `Uat flat ${RUN}`, city: UCITY, price: '70 Lakh' } });
  const P = listing.data.id;
  await pool.query(`UPDATE properties SET status = 'approved', under_review = false WHERE id = $1`, [P]);
  const phone = () => `7${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

  // ---- enquiries land in the right desk
  const loan = await api('POST', '/leads/public-inquiry', {
    body: { fullName: `Loan Seeker ${RUN}`, mobile: phone(), message: '[Home Loan & Financing] Need a loan for a flat', topic: 'Home Loan & Financing', details: { loanAmount: 4500000, employment: 'Salaried', 'bad key!': 'x' } },
  });
  assert.equal(loan.status, 201, JSON.stringify(loan.body));
  const loanRow = (await pool.query('SELECT enquiry_type, enquiry_topic, enquiry_details FROM leads WHERE id = $1', [loan.data.id])).rows[0];
  assert.equal(loanRow.enquiry_type, 'home_loan');
  assert.equal(loanRow.enquiry_topic, 'Home Loan & Financing');
  assert.deepEqual(loanRow.enquiry_details, { loanAmount: 4500000, employment: 'Salaried' });
  // Older clients send only "[Topic] message" - still classified.
  const legacy = await api('POST', '/leads/public-inquiry', { body: { fullName: `Insurer ${RUN}`, mobile: phone(), message: '[Insurance referral] cover for my home' } });
  assert.equal((await pool.query('SELECT enquiry_type FROM leads WHERE id = $1', [legacy.data.id])).rows[0].enquiry_type, 'insurance');
  const prop = await api('POST', '/leads/public-inquiry', { body: { fullName: `Buyer ${RUN}`, mobile: phone(), propertyId: P, message: '[Property enquiry] is it available' } });
  assert.equal((await pool.query('SELECT enquiry_type FROM leads WHERE id = $1', [prop.data.id])).rows[0].enquiry_type, 'property');

  const loans = await api('GET', `/enquiries?type=home_loan&search=${encodeURIComponent(`Loan Seeker ${RUN}`)}`, { token: A });
  assert.equal(loans.data.items.length, 1);
  assert.equal(loans.data.items[0].message, 'Need a loan for a flat', 'topic prefix stripped');
  assert.equal(loans.data.items[0].enquiry_details.loanAmount, 4500000);
  assert.ok(!(await api('GET', '/enquiries?type=insurance', { token: A })).data.items.some((i) => i.id === loan.data.id), 'each type in its own list');
  const summary = await api('GET', '/enquiries/summary', { token: A });
  assert.ok(summary.data.types.find((t) => t.type === 'home_loan').total >= 1 && summary.data.types.find((t) => t.type === 'insurance').new >= 1);
  assert.equal((await api('GET', `/enquiries?search=${encodeURIComponent(`Loan Seeker ${RUN}`)}`, { token: outsider.token })).data.items.length, 0, 'another broker does not see it');
  assert.equal((await api('GET', '/enquiries', { token: ctx.customer.token })).status, 403);
  // The representative the cascade assigned sees it; so does the admin.
  const rep = (await pool.query('SELECT arb_rep_id FROM leads WHERE id = $1', [loan.data.id])).rows[0].arb_rep_id;
  if (rep) {
    const repUser = (await pool.query('SELECT email FROM users WHERE id = $1', [rep])).rows[0];
    assert.ok(repUser, 'assigned representative exists');
  }

  // ---- dashboard: admins see the platform, not just leads assigned to them personally
  const dash = await api('GET', '/broker/dashboard', { token: A });
  assert.equal(dash.data.scope, 'all');
  const totalLeads = Object.values(dash.data.leadsByStatus).reduce((a, b) => a + b, 0);
  assert.ok(totalLeads >= 3 && dash.data.propertiesListedCount >= 1, JSON.stringify(dash.data));
  const mineDash = await api('GET', '/broker/dashboard', { token: outsider.token });
  assert.equal(mineDash.data.scope, 'mine');
  assert.equal(Object.values(mineDash.data.leadsByStatus).reduce((a, b) => a + b, 0), 0);
  // A lead held through the assignment cascade (arb_rep_id) counts for that representative.
  await pool.query('UPDATE leads SET arb_rep_id = $1 WHERE id = $2', [ctx.sales.id, prop.data.id]);
  const repDash = await api('GET', '/broker/dashboard', { token: S });
  assert.ok(Object.values(repDash.data.leadsByStatus).reduce((a, b) => a + b, 0) >= 1);

  // ---- site-visit request: record, CRM list, attention, schedule -> deal + visit
  const buyer = await createUser('customer', 'uatBuyer');
  await api('GET', '/me/profile', { token: buyer.token });
  const buyerCust = (await pool.query('SELECT id FROM customers WHERE user_id = $1', [buyer.id])).rows[0].id;
  const lead = (await pool.query(`INSERT INTO leads (source, property_id, customer_id, status, arb_rep_id) VALUES ('website', $1, $2, 'new', $3) RETURNING id`, [P, buyerCust, ctx.sales.id])).rows[0].id;
  const when = new Date(Date.now() + 3 * 86400000).toISOString();
  const asked = await api('POST', `/me/enquiries/${lead}/visit-request`, { token: buyer.token, body: { preferredAt: when, note: 'Evening please' } });
  assert.ok([200, 201].includes(asked.status), JSON.stringify(asked.body));
  const pending = await api('GET', '/enquiries/visit-requests', { token: S });
  const vr = pending.data.find((r) => r.lead_id === lead);
  assert.ok(vr && vr.status === 'pending' && vr.property_title === `Uat flat ${RUN}`);
  assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'visit_request' AND related_entity_id = $2`, [ctx.sales.id, lead])).rows.length, 'representative holding the enquiry is notified');
  assert.ok(!(await api('GET', '/enquiries/visit-requests', { token: outsider.token })).data.some((r) => r.id === vr.id));
  const att = await api('GET', '/enquiries/attention', { token: S });
  assert.ok(att.data.items.find((i) => i.key === 'visit_requests').count >= 1);
  assert.ok(att.data.items.some((i) => i.key === 'deal_room_requests') && att.data.items.some((i) => i.key === 'listings_pending'));
  assert.ok(!(await api('GET', '/enquiries/attention', { token: outsider.token })).data.items.some((i) => i.key === 'deal_room_requests'), 'staff-only queues hidden from brokers');
  assert.equal((await api('POST', `/enquiries/visit-requests/${vr.id}/decline`, { token: S, body: {} })).status, 422, 'decline needs a reason');
  const scheduled = await api('POST', `/enquiries/visit-requests/${vr.id}/schedule`, { token: S, body: {} });
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  assert.ok(scheduled.data.dealId && scheduled.data.siteVisitId);
  const deal = (await pool.query('SELECT lead_id, customer_id, property_id FROM deals WHERE id = $1', [scheduled.data.dealId])).rows[0];
  assert.deepEqual(deal, { lead_id: lead, customer_id: buyerCust, property_id: P });
  assert.ok((await api('GET', '/me/visits', { token: buyer.token })).data.some((v) => v.id === scheduled.data.siteVisitId), 'customer sees the booked visit');
  assert.equal((await api('POST', `/enquiries/visit-requests/${vr.id}/schedule`, { token: S, body: {} })).status, 400, 'handled once');

  // ---- a published review about a party on this property shows on the listing page
  const owner = await createUser('customer', 'uatOwner');
  await pool.query(
    `INSERT INTO reviews (reviewer_id, subject_user_id, property_id, deal_id, interaction, rating, title, body, status) VALUES ($1, $2, $3, $4, 'site_visit', 4, 'Smooth visit', $5, 'published')`,
    [buyer.id, owner.id, P, scheduled.data.dealId, `Owner was helpful ${RUN}`]
  );
  const pub = await api('GET', `/trust/public/listings/${P}`);
  assert.ok(pub.data.reviews.some((r) => r.body === `Owner was helpful ${RUN}`), 'review of a non-primary party still shows on that listing');

  // ---- reviews for the property (public) and the admin Reviews desk
  const propReviews = await api('GET', `/trust/public/properties/${P}/reviews`);
  assert.ok(propReviews.data.reviews.some((r) => r.body === `Owner was helpful ${RUN}`), 'property page lists its own reviews');
  assert.equal(propReviews.data.rating.count, propReviews.data.reviews.length);
  assert.equal((await api('GET', '/trust/reviews', { token: outsider.token })).status, 403, 'Reviews desk is staff only');
  const desk = await api('GET', `/trust/reviews?propertyId=${P}`, { token: A });
  const deskRow = desk.data.items.find((r) => r.body === `Owner was helpful ${RUN}`);
  assert.ok(deskRow && deskRow.reviewerName && deskRow.propertyId === P, 'desk shows the review with who wrote it');
  assert.ok(desk.data.stats.published >= 1);
  assert.equal((await api('PUT', `/trust/reviews/${deskRow.id}/moderate`, { token: A, body: { action: 'hide', note: 'check' } })).status, 200);
  assert.equal((await api('GET', `/trust/public/properties/${P}/reviews`)).data.reviews.some((r) => r.id === deskRow.id), false, 'hidden review leaves the website');
  assert.equal((await api('GET', `/trust/reviews?propertyId=${P}&status=hidden`, { token: A })).data.items.length, 1);
  assert.equal((await api('PUT', `/trust/reviews/${deskRow.id}/moderate`, { token: A, body: { action: 'approve' } })).status, 200);

  // ---- testimonials
  assert.equal((await api('POST', '/content/manage/testimonials', { token: outsider.token, body: { personName: 'X Y', quote: 'A fine experience overall.' } })).status, 403);
  assert.equal((await api('POST', '/content/manage/testimonials', { token: A, body: { personName: 'Asha', quote: 'Great service, call me on 9876543210 for details.' } })).status, 422, 'contact details blocked');
  const t1 = await api('POST', '/content/manage/testimonials', { token: A, body: { personName: `Asha ${RUN}`, personRole: 'Home buyer', city: UCITY, quote: `Found my flat in two weeks ${RUN}.`, rating: 5 } });
  assert.equal(t1.status, 201, JSON.stringify(t1.body));
  const hidden = await api('GET', `/content/testimonials?city=${encodeURIComponent(UCITY)}&limit=24`);
  assert.ok(!hidden.data.some((t) => t.id === t1.data.id), 'unpublished stays off the site');
  await api('PUT', `/content/manage/testimonials/${t1.data.id}`, { token: A, body: { isPublished: true } });
  const shown = await api('GET', `/content/testimonials?city=${encodeURIComponent(UCITY)}`);
  assert.equal(shown.data[0].id, t1.data.id, "a city's own testimonial comes first");
  assert.ok(!('createdBy' in shown.data[0]));
  assert.equal((await api('DELETE', `/content/manage/testimonials/${t1.data.id}`, { token: A })).status, 200);

  // ---- notification preferences: topics and quiet hours hold push back
  const prefs0 = await api('GET', '/notifications/preferences', { token: buyer.token });
  assert.equal(prefs0.data.pushEnabled, true);
  assert.equal(prefs0.data.topics.length, 6);
  assert.equal((await api('PUT', '/notifications/preferences', { token: buyer.token, body: { quietStart: '22:00' } })).status, 400, 'both ends of quiet hours');
  const saved = await api('PUT', '/notifications/preferences', { token: buyer.token, body: { pushMuted: ['rentals', 'nonsense'], quietStart: '22:00', quietEnd: '07:00', timezone: 'Asia/Kolkata' } });
  assert.deepEqual(saved.data.pushMuted, ['rentals']);
  const push = require('../src/services/push.service');
  assert.deepEqual(await push.pushAllowed(buyer.id, 'rent_due', new Date('2026-10-05T06:30:00Z')), { allowed: false, reason: 'topic_muted' });
  assert.deepEqual(await push.pushAllowed(buyer.id, 'match_hot', new Date('2026-10-05T18:00:00Z')), { allowed: false, reason: 'quiet_hours' }, '23:30 IST');
  assert.deepEqual(await push.pushAllowed(buyer.id, 'match_hot', new Date('2026-10-05T06:30:00Z')), { allowed: true }, '12:00 IST');
  await api('PUT', '/notifications/preferences', { token: buyer.token, body: { pushEnabled: false } });
  assert.equal((await push.pushAllowed(buyer.id, 'match_hot', new Date('2026-10-05T06:30:00Z'))).reason, 'push_off');
});

test('institutional engine: confidential listing, buyer qualification, NDA gate, 9-stage pipeline, due diligence, valuation, offers, closure', async () => {
  const A = ctx.admin.token;
  const S = ctx.sales.token;
  const ICITY = `Inst City ${RUN}`;
  const NAME = `Sunrise Public School ${RUN}`;
  const payload = {
    institutionName: NAME, assetClass: 'k12_school', boardAffiliation: 'CBSE', yearEstablished: new Date().getFullYear() - 25, city: ICITY, locality: 'Knowledge Park',
    address: '12 Campus Road', latitude: 28.61, longitude: 77.23, campusAreaAcres: 2, builtUpAreaSqft: 60000, buildingCount: 3, studentEnrollment: 800, facultyCount: 60,
    enrollmentHistory: [{ year: 2022, count: 600 }, { year: 2023, count: 700 }, { year: 2024, count: 800 }],
    nocStatus: 'valid', approvals: [{ name: 'CBSE affiliation', status: 'valid' }, { name: 'Fire safety certificate', status: 'pending' }],
    landOwnership: 'owned', dealType: 'full_sale', askingPriceCr: 45, annualRevenueCr: 10, ebitdaCr: 4,
  };

  // ---- who may list; geolocation is mandatory
  const plainBroker = await createUser('broker', 'instBroker');
  assert.equal((await api('POST', '/institutional/listings', { token: plainBroker.token, body: payload })).status, 403, 'only certified institutional brokers');
  const { latitude, ...noGeo } = payload;
  assert.equal((await api('POST', '/institutional/listings', { token: S, body: noGeo })).status, 400, 'lat / long mandatory');
  const created = await api('POST', '/institutional/listings', { token: S, body: payload });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const P = created.data.id;
  assert.equal(created.data.campusAreaSqft, 87120, 'acres converted');
  assert.equal(created.data.ebitdaMultiple, 11.25);
  const seller = await createUser('customer', 'instSeller');
  const sellerListing = await api('POST', '/institutional/listings', { token: seller.token, body: { ...payload, institutionName: `Seller College ${RUN}`, assetClass: 'college' } });
  assert.equal(sellerListing.data.status, 'pending_approval', "a seller's own listing waits for approval");
  assert.equal((await api('GET', `/institutional/listings/${sellerListing.data.id}`)).status, 404, 'not public until approved');

  // ---- confidentiality: the name is nowhere in the public surfaces
  const propRow = (await pool.query('SELECT title, description, listing_category, status FROM properties WHERE id = $1', [P])).rows[0];
  assert.equal(propRow.title, 'K-12 School in Knowledge Park');
  assert.ok(!JSON.stringify(propRow).includes('Sunrise'));
  const list = await api('GET', `/institutional/listings?city=${encodeURIComponent(ICITY)}&assetClass=k12_school&budgetMaxCr=50`);
  const card = list.data.items.find((i) => i.id === P);
  assert.ok(card, JSON.stringify(list.body).slice(0, 300));
  assert.equal(card.summary, 'K-12 School, 500-1,000 students, Knowledge Park, Asking ₹25-50 Cr');
  assert.ok(!JSON.stringify(list.body).includes('Sunrise') && !('askingPriceCr' in card) && !('studentEnrollment' in card) && !('latitude' in card));
  assert.match(list.data.disclaimer, /do not act as legal counsel/);
  assert.equal((await api('GET', `/institutional/listings?city=${encodeURIComponent(ICITY)}&budgetMaxCr=20`)).data.items.length, 0, 'budget filter');
  const anon = await api('GET', `/institutional/listings/${P}`);
  assert.equal(anon.data.access.full, false);
  assert.ok(!JSON.stringify(anon.body).includes('Sunrise') && !anon.data.valuation);
  for (const path of [`/properties/${P}`, `/search/properties?city=${encodeURIComponent(ICITY)}`, `/opportunities/public/${P}`]) {
    const r = await api('GET', path);
    assert.ok(!JSON.stringify(r.body).includes('Sunrise'), `${path} must not leak the institution name`);
  }

  // ---- valuation (indicative)
  const staffView = await api('GET', `/institutional/listings/${P}`, { token: S });
  assert.equal(staffView.data.listing.institutionName, NAME);
  const v = staffView.data.valuation;
  assert.equal(v.enrollmentTrend.trend, 'growing');
  assert.equal(v.ebitdaLinked.appliedMultiple, 9.9, 'sector multiple 9 + 10% for growing enrollment');
  assert.equal(v.ebitdaLinked.valueCr, 39.6);
  assert.equal(v.assetBased.landValueCr, 21.78, '87,120 sq ft x default land rate');
  assert.equal(v.assetBased.buildingReplacementCr, 16.8);
  assert.equal(v.assetBased.brandValueCr, 2, '25 years -> 20% of revenue');
  assert.equal(v.assetBased.valueCr, 41.18, 'land + building + brand + approvals (0.5 + 0.1)');
  assert.equal(v.replacementCost.valueCr, 44.37);
  assert.equal(v.impliedEbitdaMultiple, 11.3);
  assert.ok(v.exitPotential.score >= 0 && v.exitPotential.score <= 100 && v.exitPotential.factors.length === 6);
  assert.ok(!v.benchmarking.sameCity, 'no comparable in this city yet');
  await api('POST', '/institutional/manage/comparables', { token: S, body: { assetClass: 'k12_school', city: ICITY, dealYear: 2025, dealValueCr: 30, ebitdaCr: 3, enrollment: 600, areaAcres: 2 } });
  const bench = (await api('GET', `/institutional/listings/${P}`, { token: S })).data.valuation.benchmarking;
  assert.equal(bench.sameCity, 1);
  assert.ok(bench.implied.some((i) => i.basis === 'EV / EBITDA') && bench.askingVsComparablesPercent !== null);

  // ---- due diligence: checklist, automated flags, staff review
  const dd = await api('GET', `/institutional/manage/listings/${P}/due-diligence`, { token: S });
  assert.equal(dd.data.sector, 'education');
  assert.ok(['land_records', 'noc', 'fire_noc', 'affiliation_certificate', 'trust_deed'].every((t) => dd.data.checklist.some((c) => c.type === t && !c.present)));
  assert.ok(dd.data.riskFlags.some((f) => /Fire safety certificate: approval pending/.test(f.detail)));
  assert.ok(dd.data.riskFlags.some((f) => /State education department recognition/.test(f.detail)), 'expected approval not declared');
  assert.equal((await api('PUT', `/institutional/manage/listings/${P}/due-diligence`, { token: S, body: { key: 'encumbrance', status: 'issue' } })).status, 400, 'an issue needs a note');
  const reviewed = await api('PUT', `/institutional/manage/listings/${P}/due-diligence`, { token: S, body: { key: 'ownershipChain', status: 'ok', note: 'Sale deeds 1998-2001 traced' } });
  assert.equal(reviewed.data.review.find((r) => r.key === 'ownershipChain').status, 'ok');
  assert.equal((await api('GET', `/institutional/manage/listings/${P}/due-diligence`, { token: plainBroker.token })).status, 403);

  // ---- Stage 1: intent -> lead through the cascade + pipeline record
  const buyer = await createUser('customer', 'instBuyer');
  const intent = await api('POST', `/institutional/listings/${P}/interest`, { token: buyer.token, body: { message: 'Our trust runs three schools.' } });
  assert.equal(intent.status, 201, JSON.stringify(intent.body));
  const D = intent.data.id;
  assert.match(intent.data.dealNumber, /^INST-\d{4}-\d{4}$/);
  assert.equal(intent.data.stage, 'intent_received');
  assert.equal(intent.data.stages.length, 9);
  assert.ok(!('buyer' in intent.data) && !('institutionName' in intent.data.listing), 'buyer view carries no internals');
  const lead = (await pool.query('SELECT l.enquiry_type FROM institutional_deals d JOIN leads l ON l.id = d.lead_id WHERE d.id = $1', [D])).rows[0];
  assert.equal(lead.enquiry_type, 'institutional');
  assert.equal((await api('POST', `/institutional/listings/${P}/interest`, { token: buyer.token, body: {} })).data.id, D, 'one live deal per buyer per asset');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM institutional_deals WHERE property_id = $1', [P])).rows[0].n, 1);
  const staffDeal = () => api('GET', `/institutional/deals/${D}`, { token: S });
  const act = (action, body = {}) => api('POST', `/institutional/manage/deals/${D}/${action}`, { token: S, body });

  // ---- Stage 2: screened -> Buyer Qualification
  assert.equal((await act('screen', { note: 'Genuine education trust' })).data.stage, 'buyer_qualification');
  // NDA is refused until the buyer is qualified.
  const nda = (name) => api('POST', `/deal-room/${P}/nda`, { token: buyer.token, body: { fullName: name, accept: true } });
  assert.equal((await nda('Inst Buyer')).status, 403);
  assert.equal((await api('GET', `/institutional/deals/${D}`, { token: buyer.token })).data.yourAction, 'complete_buyer_profile');
  const profile = await api('PUT', '/institutional/buyer-profile', { token: buyer.token, body: { buyerType: 'trust', organisationName: `Vidya Trust ${RUN}`, budgetMinCr: 20, budgetMaxCr: 60, geographies: [ICITY], assetClasses: ['k12_school'], intent: 'Acquire a running CBSE school', capacityNote: 'Corpus of 80 Cr, banker letter available' } });
  assert.equal(profile.data.status, 'pending');
  assert.equal((await api('PUT', `/institutional/manage/buyers/${buyer.id}`, { token: S, body: { decision: 'rejected' } })).status, 400, 'rejection needs a reason');
  assert.equal((await api('PUT', `/institutional/manage/buyers/${buyer.id}`, { token: S, body: { decision: 'qualified', note: 'Banker letter seen' } })).data.status, 'qualified');
  assert.equal((await staffDeal()).data.stage, 'buyer_qualification', 'qualified but NDA not signed yet');
  assert.equal((await api('GET', `/institutional/deals/${D}`, { token: buyer.token })).data.yourAction, 'sign_nda');

  // ---- Stage 3: NDA executed (auto)
  assert.ok([200, 201].includes((await nda('Inst Buyer')).status));
  assert.equal((await staffDeal()).data.stage, 'nda_executed');
  assert.equal((await api('GET', `/institutional/listings/${P}`, { token: buyer.token })).data.access.full, false, 'NDA alone does not unlock - admin approval pending');

  // ---- Stage 4: admin approval -> Data Room Access; full details unlocked
  const reqs = await api('GET', '/deal-room/manage/requests?status=pending_approval', { token: A });
  const accessId = reqs.data.find((r) => r.property_id === P && r.user_id === buyer.id).id;
  await api('PUT', `/deal-room/manage/access/${accessId}`, { token: A, body: { action: 'approve' } });
  assert.equal((await staffDeal()).data.stage, 'data_room_access');
  const unlocked = await api('GET', `/institutional/listings/${P}`, { token: buyer.token });
  assert.equal(unlocked.data.access.full, true);
  assert.equal(unlocked.data.listing.institutionName, NAME);
  assert.ok(unlocked.data.valuation && unlocked.data.dueDiligence && unlocked.data.dueDiligence.review.every((r) => r.note === undefined), 'buyer sees review status, not staff notes');
  const stranger = await createUser('customer', 'instStranger');
  assert.equal((await api('GET', `/institutional/listings/${P}`, { token: stranger.token })).data.access.full, false);
  assert.equal((await api('GET', `/institutional/deals/${D}`, { token: stranger.token })).status, 403);

  // ---- Stages 5-8
  assert.equal((await act('complete_visit')).status, 400, 'visit must be scheduled first');
  assert.equal((await act('schedule_visit', { at: new Date(Date.now() + 86400000).toISOString() })).data.stage, 'site_visit');
  assert.equal((await act('complete_visit')).data.stage, 'valuation_discussion');
  assert.equal((await api('POST', `/institutional/deals/${D}/offers`, { token: buyer.token, body: { amountCr: 36 } })).status, 400, 'offers open at stage 8');
  assert.equal((await act('share_valuation')).data.stage, 'legal_due_diligence');
  assert.equal((await act('clear_legal')).status, 400, "legal panel's finding required");
  assert.equal((await act('clear_legal', { note: 'Title, trust deed and CBSE affiliation reviewed - clear' })).data.stage, 'offer_negotiation');

  // ---- Stage 8: term sheet, offer, counter-offer
  await api('POST', `/institutional/deals/${D}/offers`, { token: S, body: { kind: 'term_sheet', byParty: 'seller', amountCr: 42, terms: 'Full sale, 90-day completion' } });
  const offered = await api('POST', `/institutional/deals/${D}/offers`, { token: buyer.token, body: { amountCr: 36, kind: 'term_sheet', byParty: 'seller' } });
  assert.equal(offered.status, 201);
  assert.deepEqual([offered.data.offers[0].kind, offered.data.offers[0].byParty, offered.data.offers[0].status], ['offer', 'buyer', 'open'], 'a buyer can only make a buyer offer');
  assert.equal(offered.data.offers[1].status, 'superseded');
  const counter = await api('POST', `/institutional/deals/${D}/offers`, { token: S, body: { kind: 'counter_offer', byParty: 'seller', amountCr: 38 } });
  assert.equal((await api('PUT', `/institutional/manage/offers/${counter.data.offers[0].id}`, { token: buyer.token, body: { decision: 'accepted' } })).status, 403);
  const accepted = await api('PUT', `/institutional/manage/offers/${counter.data.offers[0].id}`, { token: S, body: { decision: 'accepted' } });
  assert.equal(accepted.data.stage, 'closure');
  assert.equal(accepted.data.agreedValueCr, 38);

  // ---- admin override is logged; staff cannot
  assert.equal((await act('move', { stage: 'site_visit', note: 'x' })).status, 403);
  // ---- a second buyer's deal on the same asset (to be ended on closure) and a guest enquiry
  const buyer2 = await createUser('customer', 'instBuyer2');
  const D2 = (await api('POST', `/institutional/listings/${P}/interest`, { token: buyer2.token, body: {} })).data.id;
  const guestLead = await api('POST', '/leads/public-inquiry', { body: { fullName: `Inst Guest ${RUN}`, mobile: `7${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`, propertyId: P, message: '[Property enquiry] interested' } });
  const guestDeal = (await pool.query('SELECT source, buyer_user_id, stage FROM institutional_deals WHERE lead_id = $1', [guestLead.data.id])).rows[0];
  assert.deepEqual(guestDeal, { source: 'platform', buyer_user_id: null, stage: 'intent_received' }, 'an enquiry by any route opens Stage 1');

  // ---- Stage 9: closure
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await api('POST', `/institutional/manage/deals/${D}/close`, { token: S, body: { agreementDate: today, paymentConfirmed: false } })).status, 400);
  const closed = await api('POST', `/institutional/manage/deals/${D}/close`, { token: S, body: { agreementDate: today, paymentConfirmed: true } });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.data.status, 'closed_won');
  assert.equal(closed.data.advisoryFeeCr, 0.38, '1% of 38 Cr');
  assert.ok(closed.data.stages.every((s) => s.done));
  assert.equal((await pool.query('SELECT status::text FROM properties WHERE id = $1', [P])).rows[0].status, 'inactive');
  assert.equal((await pool.query('SELECT status FROM institutional_deals WHERE id = $1', [D2])).rows[0].status, 'dropped');
  assert.ok((await pool.query(`SELECT 1 FROM institutional_comparables WHERE deal_id = $1 AND deal_value_cr = 38`, [D])).rows.length, 'closed deal becomes a comparable');
  await assert.rejects(pool.query('DELETE FROM institutional_deal_events WHERE deal_id = $1', [D]), /append-only/);
  const kinds = closed.data.events.map((e) => e.kind);
  assert.ok(['created', 'stage', 'site_visit', 'valuation', 'legal', 'offer', 'closed'].every((k) => kinds.includes(k)));
  assert.equal((await act('note', { note: 'x' })).status, 400, 'closed deals are final');

  // ---- desk views
  const pipeline = await api('GET', '/institutional/manage/deals?status=all', { token: S });
  assert.equal(pipeline.data.stages.length, 9);
  assert.ok(pipeline.data.items.some((i) => i.id === D && i.institutionName === NAME && i.ndaSigned));
  assert.equal((await api('GET', '/institutional/manage/deals', { token: plainBroker.token })).status, 403);
  const mine = await api('GET', '/institutional/my/deals', { token: buyer.token });
  assert.equal(mine.data[0].id, D);
  assert.ok((await api('GET', '/institutional/my/listings', { token: seller.token })).data.some((l) => l.id === sellerListing.data.id));
  assert.ok((await api('GET', '/institutional/manage/summary', { token: S })).data.closed_deals >= 1);
  assert.equal((await api('GET', '/institutional/meta')).data.stages[8].label, 'Closure');
});

test('advertising: eligibility approval + AV code, rate card, GST invoice, payment, campaign review checks, serving with targeting / frequency cap / A-B, stats, revenue', async () => {
  const A = ctx.admin.token;
  const ADCITY = `Ad City ${RUN}`;
  const day = (offset) => new Date(Date.now() + offset * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);

  // No self-signup: the public can only raise an enquiry; the portal is closed to other roles.
  const reg = await api('POST', '/auth/register', { body: { fullName: 'Self Ad', email: `selfad.${RUN}@e2e.test`, password: PASSWORD, role: 'advertiser' } });
  assert.equal(reg.status, 422);
  assert.equal((await api('GET', '/ads/portal', { token: ctx.broker.token })).status, 403);
  const lead = await api('POST', '/bd-leads', { body: { category: 'advertiser', fullName: `Builder Ad ${RUN}`, email: `bd.ad.${RUN}@e2e.test`, businessName: `Skyline Builders ${RUN}`, businessCategory: 'builder_developer', desiredPlacement: 'Area page' } });
  assert.equal(lead.status, 201, JSON.stringify(lead.body));
  const enquiries = await api('GET', '/ads/manage/enquiries', { token: A });
  assert.ok(enquiries.data.some((e) => e.id === lead.data.id && e.eligible));

  // Eligibility approval -> AV code + portal login; the enquiry is converted.
  assert.equal((await api('POST', '/ads/manage/advertisers', { token: ctx.sales.token, body: { bdLeadId: lead.data.id, password: PASSWORD } })).status, 403);
  const notEligible = await api('POST', '/ads/manage/advertisers', { token: A, body: { businessName: 'Coin Flip', businessCategory: 'crypto_exchange', loginEmail: `coin.${RUN}@e2e.test`, password: PASSWORD } });
  assert.equal(notEligible.status, 400);
  const adv = await api('POST', '/ads/manage/advertisers', { token: A, body: { bdLeadId: lead.data.id, password: PASSWORD } });
  assert.equal(adv.status, 201, JSON.stringify(adv.body));
  assert.match(adv.data.avCode, /^AV-\d{4,}$/);
  assert.equal(adv.data.source, 'inbound');
  assert.equal((await api('POST', '/ads/manage/advertisers', { token: A, body: { bdLeadId: lead.data.id, password: PASSWORD, loginEmail: `x.${RUN}@e2e.test` } })).status, 400, 'an enquiry is approved once');
  assert.equal((await pool.query('SELECT status::text FROM bd_leads WHERE id = $1', [lead.data.id])).rows[0].status, 'converted');
  const login = await api('POST', '/auth/login', { body: { identifier: `bd.ad.${RUN}@e2e.test`, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const V = login.data.accessToken;
  const home = await api('GET', '/ads/portal', { token: V });
  assert.equal(home.data.advertiser.avCode, adv.data.avCode);

  // Rate card: admin sets a city rate; the quote uses it and adds GST 18%.
  assert.equal((await api('POST', '/ads/manage/rates', { token: V, body: { formatKey: 'city_banner', city: ADCITY, rate: 5 } })).status, 403);
  const rate = await api('POST', '/ads/manage/rates', { token: A, body: { formatKey: 'city_banner', city: ADCITY, rate: 20000 } });
  assert.equal(rate.status, 200, JSON.stringify(rate.body));
  const card = await api('GET', '/ads/rate-card', { token: V });
  assert.ok(card.data.items.some((i) => i.formatKey === 'home_sidebar' && i.minUnits === 2) && card.data.items.some((i) => i.formatKey === 'package_builder'));
  const q = await api('POST', '/ads/quote', { token: V, body: { formatKey: 'city_banner', units: 2, city: ADCITY } });
  assert.deepEqual([q.data.amount, q.data.gstAmount, q.data.total], [40000, 7200, 47200]);
  assert.equal((await api('POST', '/ads/quote', { token: V, body: { formatKey: 'home_sidebar', units: 1 } })).status, 400, 'minimum 2 weeks');

  // Campaign: validation, then created with an invoice and waiting for payment.
  const base = { name: `Launch ${RUN}`, formatKey: 'city_banner', units: 2, startDate: day(0), headline: 'Skyline Heights - 3 BHK homes', body: 'Guaranteed returns on every booking', ctaUrl: 'https://example.com/skyline', targeting: { cities: [ADCITY], roles: ['all'], device: 'all' }, variantB: { headline: 'Skyline Heights - ready to move' } };
  assert.equal((await api('POST', '/ads/campaigns', { token: V, body: { ...base, ctaUrl: 'http://example.com' } })).status, 400, 'https only');
  assert.equal((await api('POST', '/ads/campaigns', { token: V, body: { ...base, targeting: {} } })).status, 400, 'area banner needs a city');
  assert.equal((await api('POST', '/ads/campaigns', { token: V, body: { ...base, formatKey: 'featured_listing' } })).status, 400, 'listing format needs a listing');
  const camp = await api('POST', '/ads/campaigns', { token: V, body: base });
  assert.equal(camp.status, 201, JSON.stringify(camp.body));
  assert.equal(camp.data.status, 'pending_payment');
  assert.equal(camp.data.invoice.total, 47200);
  assert.match(camp.data.invoice.number, /^ADV\/\d{4}-\d{2}\/\d{6}$/);
  const id = camp.data.id;
  const invId = camp.data.invoice.id;
  // Unpaid and unapproved -> never served.
  assert.equal((await api('GET', `/ads/serve?placement=city_banner&city=${encodeURIComponent(ADCITY)}&viewer=v0`)).data.ads.length, 0);
  const other = await createUser('customer', 'adsnoop');
  assert.equal((await api('GET', `/ads/campaigns/${id}`, { token: other.token })).status, 403);

  // Payment: online is off without Razorpay keys; staff record a bank transfer; a PDF invoice exists.
  assert.equal((await api('POST', `/ads/invoices/${invId}/pay/order`, { token: V })).status, 400);
  assert.equal((await api('POST', `/ads/invoices/${invId}/pay/record`, { token: V, body: { reference: 'UTR123' } })).status, 403);
  const paid = await api('POST', `/ads/invoices/${invId}/pay/record`, { token: ctx.sales.token, body: { reference: `UTR${RUN}` } });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.data.status, 'pending_review');
  const pdf = await fetch(`${BASE}/ads/invoices/${invId}/pdf`, { headers: { authorization: `Bearer ${V}` } });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');

  // Review: prohibited claim + missing RERA block approval; reject needs a reason.
  const flagged = await api('GET', `/ads/campaigns/${id}`, { token: A });
  assert.ok(flagged.data.reviewFlags.some((f) => f.rule === 'prohibited_claim') && flagged.data.reviewFlags.some((f) => f.rule === 'rera_missing'), JSON.stringify(flagged.data.reviewFlags));
  assert.equal((await api('POST', `/ads/campaigns/${id}/review`, { token: ctx.sales.token, body: { decision: 'approve' } })).status, 403);
  const blocked = await api('POST', `/ads/campaigns/${id}/review`, { token: A, body: { decision: 'approve' } });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.message, /Prohibited claim/);
  assert.equal((await api('POST', `/ads/campaigns/${id}/review`, { token: A, body: { decision: 'reject' } })).status, 400);
  const rejected = await api('POST', `/ads/campaigns/${id}/review`, { token: A, body: { decision: 'reject', note: 'Remove the returns claim and add the RERA number.' } });
  assert.equal(rejected.data.status, 'rejected');
  // The advertiser fixes the creative -> back to review -> approved.
  const fixed = await api('PATCH', `/ads/campaigns/${id}`, { token: V, body: { body: 'Sample flat open this weekend', reraNumber: 'DLRERA2026P0001' } });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal(fixed.data.status, 'pending_review');
  const approved = await api('POST', `/ads/campaigns/${id}/review`, { token: A, body: { decision: 'approve' } });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.data.state, 'active');

  // Serving: city targeting, labelled, impressions logged, frequency cap of 3 per viewer per day, A/B variants.
  assert.equal((await api('GET', '/ads/serve?placement=city_banner&city=Elsewhere&viewer=v1')).data.ads.length, 0);
  const serveUrl = (viewer) => `/ads/serve?placement=city_banner&city=${encodeURIComponent(ADCITY)}&viewer=${viewer}&device=mobile`;
  const first = await api('GET', serveUrl('v1'));
  assert.equal(first.data.ads.length, 1, JSON.stringify(first.body));
  const ad = first.data.ads[0];
  assert.equal(ad.campaignId, id);
  assert.equal(ad.label, 'Sponsored');
  assert.equal(ad.reraNumber, 'DLRERA2026P0001');
  await api('GET', serveUrl('v1'));
  await api('GET', serveUrl('v1'));
  assert.equal((await api('GET', serveUrl('v1'))).data.ads.length, 0, 'capped after 3 views today');
  // The same page view asking again is one impression, not two.
  const before = (await pool.query(`SELECT COUNT(*)::int AS n FROM ad_events WHERE campaign_id = $1`, [id])).rows[0].n;
  for (let i = 0; i < 3; i += 1) assert.equal((await api('GET', `${serveUrl('pv')}&view=view-${RUN}`)).data.ads.length, 1);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM ad_events WHERE campaign_id = $1`, [id])).rows[0].n, before + 1);
  const variants = new Set([ad.variant]);
  for (let i = 0; i < 12 && variants.size < 2; i += 1) variants.add((await api('GET', serveUrl(`ab${i}`))).data.ads[0].variant);
  assert.equal(variants.size, 2, 'both creatives are served');
  const clicked = await api('POST', `/ads/click/${id}`, { body: { placement: 'city_banner', variant: ad.variant, viewer: 'v1' } });
  assert.equal(clicked.data.url, 'https://example.com/skyline');

  // Advertiser dashboard: impressions, clicks, CTR, variant split; pause stops serving.
  const stats = (await api('GET', `/ads/campaigns/${id}`, { token: V })).data;
  assert.ok(stats.stats.impressions >= 4 && stats.stats.clicks === 1 && stats.stats.ctr > 0, JSON.stringify(stats.stats));
  assert.equal(stats.stats.impressionsToday, stats.stats.impressions);
  assert.equal(stats.stats.variants.length, 2);
  assert.equal(stats.spent + stats.remaining, 40000);
  assert.equal((await api('POST', `/ads/campaigns/${id}/pause`, { token: V })).data.status, 'paused');
  assert.equal((await api('GET', serveUrl('v9'))).data.ads.length, 0);
  assert.equal((await api('POST', `/ads/campaigns/${id}/resume`, { token: V })).data.status, 'approved');

  // Role targeting: a broker-only CRM banner reaches brokers, not customers or staff. A zero-rated format needs no payment.
  const crm = await api('POST', '/ads/campaigns', { token: V, body: { name: `CRM ${RUN}`, formatKey: 'crm_dashboard', startDate: day(0), headline: `Channel partner scheme ${RUN}`, ctaUrl: 'https://example.com/cp', reraNumber: 'DLRERA2026P0001', targeting: { roles: ['broker'] } } });
  assert.equal(crm.status, 201, JSON.stringify(crm.body));
  assert.equal(crm.data.status, 'pending_review', 'nothing to pay at a zero rate');
  await api('POST', `/ads/campaigns/${crm.data.id}/review`, { token: A, body: { decision: 'approve' } });
  for (const c of (await pool.query(`SELECT id FROM ad_campaigns WHERE id <> $1 AND status = 'approved' AND placements ? 'crm_dashboard'`, [crm.data.id])).rows) await pool.query(`UPDATE ad_campaigns SET status = 'ended' WHERE id = $1`, [c.id]);
  assert.equal((await api('GET', '/ads/serve?placement=crm_dashboard', { token: ctx.broker.token })).data.ads[0]?.campaignId, crm.data.id);
  assert.equal((await api('GET', '/ads/serve?placement=crm_dashboard', { token: ctx.customer.token })).data.ads.length, 0);
  assert.equal((await api('GET', '/ads/serve?placement=crm_dashboard')).data.ads.length, 0);

  // Sponsored listing: promotes a live listing and carries its public card.
  const prop = (await pool.query(`INSERT INTO properties (created_by, title, property_type, transaction_type, city, locality, price, status) VALUES ($1, $2, 'apartment', 'sell', $3, 'Sector 1', '80 Lakh', 'approved') RETURNING id`, [ctx.admin.id, `Sponsored flat ${RUN}`, ADCITY])).rows[0].id;
  const sp = await api('POST', '/ads/campaigns', { token: V, body: { name: `Sponsored ${RUN}`, formatKey: 'search_sponsored', startDate: day(0), propertyId: prop, reraNumber: 'DLRERA2026P0001', targeting: { cities: [ADCITY] } } });
  assert.equal(sp.status, 201, JSON.stringify(sp.body));
  await api('POST', `/ads/campaigns/${sp.data.id}/review`, { token: A, body: { decision: 'approve' } });
  await pool.query(`UPDATE ad_campaigns SET status = 'ended' WHERE id <> $1 AND status = 'approved' AND placements ? 'search_sponsored'`, [sp.data.id]);
  const sponsored = await api('GET', `/ads/serve?placement=search_sponsored&city=${encodeURIComponent(ADCITY)}&viewer=s1`);
  assert.equal(sponsored.data.ads[0].listing.id, prop);
  assert.equal(sponsored.data.ads[0].listing.title, `Sponsored flat ${RUN}`);

  // Exclusive slot: a second login splash over the same dates cannot be approved.
  const far = 400 + (parseInt(RUN, 16) % 3000) * 8;
  const splash = (n) => api('POST', '/ads/campaigns', { token: V, body: { name: `Splash ${n} ${RUN}`, formatKey: 'login_splash', startDate: day(far), headline: `Splash ${n}`, ctaUrl: 'https://example.com/s', reraNumber: 'DLRERA2026P0001' } });
  const s1 = await splash(1);
  assert.equal((await api('POST', `/ads/campaigns/${s1.data.id}/review`, { token: A, body: { decision: 'approve' } })).status, 200);
  const s2 = await splash(2);
  const clash = await api('POST', `/ads/campaigns/${s2.data.id}/review`, { token: A, body: { decision: 'approve' } });
  assert.equal(clash.status, 400);
  assert.match(clash.body.message, /exclusive/);

  // Digest slot: one sponsored line per digest, counted against the booked sends.
  const dg = await api('POST', '/ads/campaigns', { token: V, body: { name: `Digest ${RUN}`, formatKey: 'digest_sponsored', units: 5, startDate: day(0), headline: `Digest offer ${RUN}`, body: 'Site visits this weekend', ctaUrl: 'https://example.com/d', reraNumber: 'DLRERA2026P0001' } });
  assert.equal(dg.status, 201, JSON.stringify(dg.body));
  await api('POST', `/ads/campaigns/${dg.data.id}/review`, { token: A, body: { decision: 'approve' } });
  await pool.query(`UPDATE ad_campaigns SET status = 'ended' WHERE id <> $1 AND status = 'approved' AND placements ? 'digest_sponsored'`, [dg.data.id]);
  const line = await require('../src/services/advertising.service').digestSponsor(ctx.customer.id);
  assert.match(line, new RegExp(`^Sponsored: Digest offer ${RUN}`));
  assert.equal((await api('GET', `/ads/campaigns/${dg.data.id}`, { token: V })).data.sendsUsed, 1);

  // Admin: revenue dashboard, advertiser list, suggestions; sweep ends finished campaigns.
  const rev = await api('GET', '/ads/manage/revenue', { token: A });
  assert.ok(rev.data.revenueThisMonth >= 40000 && rev.data.revenueYtd >= 40000 && rev.data.activeCampaigns >= 1, JSON.stringify(rev.data));
  // (Top advertisers is a top-10 list, so on a database with many earlier runs this run's advertiser may not be in it.)
  assert.ok(rev.data.revenueByFormat.some((f) => f.format_key === 'city_banner') && rev.data.topAdvertisers.length >= 1 && rev.data.topAdvertisers[0].spend >= 40000);
  const list = await api('GET', '/ads/manage/advertisers', { token: A });
  assert.equal(list.data.items.find((x) => x.id === adv.data.id).totalSpend, 40000);
  assert.equal((await api('GET', '/ads/manage/suggestions', { token: A })).status, 200);
  assert.equal((await api('GET', '/ads/manage/revenue', { token: V })).status, 403);
  await pool.query(`UPDATE ad_campaigns SET start_date = CURRENT_DATE - 20, end_date = CURRENT_DATE - 1 WHERE id = $1`, [id]);
  const swept = await api('POST', '/ads/manage/sweep', { token: A });
  assert.ok(swept.data.ended >= 1);
  assert.equal((await api('GET', `/ads/campaigns/${id}`, { token: V })).data.status, 'ended');

  // A suspended advertiser stops serving and loses the portal.
  await api('PATCH', `/ads/manage/advertisers/${adv.data.id}`, { token: A, body: { status: 'suspended' } });
  assert.equal((await api('GET', `/ads/serve?placement=search_sponsored&city=${encodeURIComponent(ADCITY)}&viewer=s2`)).data.ads.length, 0);
  assert.equal((await api('GET', '/ads/portal', { token: V })).status, 403);
});

test('gamification: points from platform activity, idempotent sync, tiers, streak-safe login point, area + platform leaderboards, admin rules / tiers / adjustments', async () => {
  const A = ctx.admin.token;
  const GCITY = `Game City ${RUN}`;
  const b1 = await createUser('broker', 'gamer1');
  const b2 = await createUser('broker', 'gamer2');
  const cust = await createUser('customer', 'gamecust');

  // Signing in earned the daily point once (createUser logs in via the API).
  await new Promise((r) => setTimeout(r, 300));
  const start = await api('GET', '/gamification/me', { token: b1.token });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal(start.data.totalPoints, 2);
  assert.equal(start.data.tier.key, 'bronze');
  assert.equal(start.data.nextTier.key, 'silver');
  assert.ok(start.data.howToEarn.some((r) => r.action_key === 'deal_closed') && !start.data.howToEarn.some((r) => r.action_key === 'requirement_posted'), 'broker rules only');
  await api('POST', '/auth/login', { body: { identifier: b1.email, password: PASSWORD } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await api('GET', '/gamification/me', { token: b1.token })).data.totalPoints, 2, 'one sign-in point per day');
  assert.equal((await api('GET', '/gamification/me', { token: ctx.admin.token })).status, 403, 'staff do not play');

  // Activity already on the platform turns into points: 2 approved listings (1 verified), a fast lead response, a closed deal.
  const prop = async (owner, title, verified) => (await pool.query(
    `INSERT INTO properties (created_by, broker_id, title, property_type, transaction_type, city, price, status, approved_at, is_verified) VALUES ($1, $1, $2, 'apartment', 'sell', $3, '1 Cr', 'approved', now(), $4) RETURNING id`,
    [owner.id, `${title} ${RUN}`, GCITY, verified])).rows[0].id;
  const p1 = await prop(b1, 'Game flat one', true);
  await prop(b1, 'Game flat two', false);
  await prop(b2, 'Game flat three', false);
  const custId = (await pool.query(`INSERT INTO customers (full_name, mobile, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`, [`Game cust ${RUN}`, `96${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, cust.id])).rows[0]?.id
    || (await pool.query('SELECT id FROM customers WHERE user_id = $1', [cust.id])).rows[0].id;
  const lead = (await pool.query(`INSERT INTO leads (created_by, source, property_id, customer_id, assigned_to, first_contacted_by, first_contacted_at, response_sla_due_at) VALUES ($1, 'manual', $2, $3, $1, $1, now(), now() + interval '1 hour') RETURNING id`, [b1.id, p1, custId])).rows[0].id;
  await pool.query(`INSERT INTO deals (lead_id, customer_id, property_id, broker_id, stage, closed_at) VALUES ($1, $2, $3, $4, 'closed_won', now())`, [lead, custId, p1, b1.id]);

  const after = await api('GET', '/gamification/me', { token: b1.token });
  // 2 login + 2x20 approved + 15 verified + 10 fast response + 100 deal
  assert.equal(after.data.totalPoints, 167, JSON.stringify(after.data.byAction));
  assert.equal(after.data.pointsThisMonth, 167);
  assert.ok(after.data.cities.some((c) => c.city === GCITY && c.points === 165));
  assert.equal(after.data.pointsToNext, 250 - 167);
  // Idempotent: a second sync awards nothing new.
  const again = await api('POST', '/gamification/manage/sync', { token: A });
  assert.equal(again.status, 200);
  assert.equal((await api('GET', '/gamification/me', { token: b1.token })).data.totalPoints, 167);
  // The customer earns on their own board: sign-in + completed purchase.
  const cme = await api('GET', '/gamification/me', { token: cust.token });
  assert.equal(cme.data.totalPoints, 52, JSON.stringify(cme.data.byAction));
  assert.equal(cme.data.audience, 'customer');

  // Area leaderboard: b1 ahead of b2 in the city; customers are not on the professional board.
  await api('GET', '/gamification/me', { token: b2.token });
  const area = await api('GET', `/gamification/leaderboard?scope=area&city=${encodeURIComponent(GCITY)}&period=month`, { token: b2.token });
  assert.equal(area.status, 200, JSON.stringify(area.body));
  assert.deepEqual(area.data.items.map((i) => [i.rank, i.points]), [[1, 165], [2, 20]]);
  assert.equal(area.data.me.rank, 2);
  assert.ok(area.data.items[1].isMe && !area.data.items[0].isMe);
  assert.equal((await api('GET', '/gamification/leaderboard?scope=area', { token: b2.token })).status, 400);
  const platform = await api('GET', '/gamification/leaderboard?period=all', { token: b1.token });
  assert.ok(platform.data.me.points >= 167 && platform.data.items.every((i, n, arr) => n === 0 || arr[n - 1].points >= i.points));
  // Customers see a customer board with masked names.
  const cboard = await api('GET', '/gamification/leaderboard?period=month', { token: cust.token });
  assert.equal(cboard.data.audience, 'customer');
  assert.ok(cboard.data.items.every((i) => i.userId === undefined && !/gamecust \w{6}$/.test(i.name)));
  assert.ok((await api('GET', '/gamification/cities', { token: b1.token })).data.some((c) => c.city === GCITY));

  // Admin: bonus with a reason moves the tier and notifies; deduction is another ledger row.
  assert.equal((await api('POST', '/gamification/manage/adjust', { token: ctx.sales.token, body: { userId: b1.id, points: 100, reason: 'Top performer' } })).status, 403);
  assert.equal((await api('POST', '/gamification/manage/adjust', { token: A, body: { userId: b1.id, points: 100 } })).status, 422);
  const bonus = await api('POST', '/gamification/manage/adjust', { token: A, body: { userId: b1.id, points: 100, reason: 'Best broker of the month' } });
  assert.equal(bonus.status, 200, JSON.stringify(bonus.body));
  assert.equal(bonus.data.tier, 'silver');
  const notes = await pool.query(`SELECT title FROM notifications WHERE user_id = $1 AND type = 'gamification'`, [b1.id]);
  assert.ok(notes.rows.some((n) => n.title === 'You reached Silver') && notes.rows.some((n) => n.title === '100 bonus points'));
  await api('POST', '/gamification/manage/adjust', { token: A, body: { userId: b1.id, points: -50, reason: 'Duplicate listing removed' } });
  const fin = await api('GET', '/gamification/me', { token: b1.token });
  assert.equal(fin.data.totalPoints, 217);
  assert.equal(fin.data.tier.key, 'bronze');
  await assert.rejects(pool.query(`UPDATE gamification_points SET points = 9999 WHERE user_id = $1`, [b1.id]), /append-only/);

  // Rules and tiers are admin-configurable; a switched-off rule stops awarding.
  const settings = await api('GET', '/gamification/manage/settings', { token: ctx.sales.token });
  assert.equal(settings.data.tiers.length, 5);
  assert.deepEqual(settings.data.tiers.map((t) => t.label), ['Bronze', 'Silver', 'Gold', 'Platinum', 'Elite']);
  assert.equal((await api('PUT', '/gamification/manage/rules/listing_approved', { token: ctx.sales.token, body: { points: 5 } })).status, 403);
  try {
    assert.equal((await api('PUT', '/gamification/manage/rules/listing_approved', { token: A, body: { isActive: false } })).status, 200);
    await prop(b2, 'Game flat four', false);
    assert.equal((await api('GET', '/gamification/me', { token: b2.token })).data.totalPoints, 22, 'no points while the rule is off');
    const bad = await api('PUT', '/gamification/manage/tiers', { token: A, body: { tiers: settings.data.tiers.map((t) => ({ key: t.key, min: 10 })) } });
    assert.equal(bad.status, 400);
  } finally {
    await api('PUT', '/gamification/manage/rules/listing_approved', { token: A, body: { isActive: true } });
  }
});

test('languages: Hindi live at launch, public bundle with ETag, saved preference, self-serve regional language (activate, upload file, export template), catalogue import', async () => {
  const A = ctx.admin.token;
  // Public: English + Hindi are offered; regional languages are listed but off.
  const langs = await api('GET', '/i18n/languages');
  assert.equal(langs.status, 200);
  assert.ok(langs.data.some((l) => l.code === 'en') && langs.data.some((l) => l.code === 'hi' && l.nativeName === 'हिन्दी'));
  assert.ok(!langs.data.some((l) => l.code === 'ta'));
  const hi = await fetch(`${BASE}/i18n/bundle/hi?app=website`);
  const hiBody = await hi.json();
  assert.equal(hiBody.data.strings['Post Property'], 'प्रॉपर्टी पोस्ट करें');
  assert.equal((await fetch(`${BASE}/i18n/bundle/hi?app=website`, { headers: { 'if-none-match': hi.headers.get('etag') } })).status, 304);
  assert.equal((await api('GET', '/i18n/bundle/hi?app=crm')).data.strings.Dashboard, 'डैशबोर्ड');
  assert.deepEqual((await api('GET', '/i18n/bundle/en?app=website')).data.strings, {});
  assert.deepEqual((await api('GET', '/i18n/bundle/ta?app=website')).data.strings, {}, 'an inactive language serves nothing');
  assert.equal((await api('GET', '/i18n/bundle/hi?app=nope')).status, 422);

  // A person's choice is saved on the account; only offered languages are accepted.
  assert.equal((await api('PUT', '/i18n/me', { token: ctx.customer.token, body: { language: 'ta' } })).status, 400);
  assert.equal((await api('PUT', '/i18n/me', { token: ctx.customer.token, body: { language: 'hi' } })).status, 200);
  assert.equal((await api('GET', '/i18n/me', { token: ctx.customer.token })).data.language, 'hi');

  // Admin overview: coverage per language and app.
  assert.equal((await api('GET', '/i18n/manage/overview', { token: ctx.broker.token })).status, 403);
  const over = await api('GET', '/i18n/manage/overview', { token: A });
  const hiRow = over.data.languages.find((l) => l.code === 'hi');
  assert.ok(hiRow.isActive && hiRow.coverage.find((c) => c.app === 'website').translated > 200);
  assert.ok(over.data.apps.find((a) => a.app === 'crm').strings > 1000);

  // Self-serve regional language: a new code, uploaded as a file, switched on - no deployment.
  const code = `x${RUN.slice(0, 2)}`.replace(/[^a-z]/g, 'q');
  assert.equal((await api('POST', '/i18n/manage/languages', { token: ctx.sales.token, body: { code, name: 'Test', nativeName: 'Test' } })).status, 403);
  assert.equal((await api('POST', '/i18n/manage/languages', { token: A, body: { code } })).status, 400, 'a new language needs its names');
  const added = await api('POST', '/i18n/manage/languages', { token: A, body: { code, name: `Testish ${RUN}`, nativeName: `टेस्ट ${RUN}` } });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const newText = `Brand new screen text ${RUN}`;
  const up = await api('PUT', '/i18n/manage/strings', { token: A, body: { language: code, app: 'website', entries: { 'Post Property': `PP-${RUN}`, [newText]: `NT-${RUN}`, 'Buy': '' } } });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.data.saved, 2);
  assert.deepEqual((await api('GET', `/i18n/bundle/${code}?app=website`)).data.strings, {}, 'not served until switched on');
  await api('POST', '/i18n/manage/languages', { token: A, body: { code, isActive: true } });
  assert.ok((await api('GET', '/i18n/languages')).data.some((l) => l.code === code));
  const served = (await api('GET', `/i18n/bundle/${code}?app=website`)).data.strings;
  assert.equal(served['Post Property'], `PP-${RUN}`);
  assert.equal(served[newText], `NT-${RUN}`);
  assert.equal((await api('PUT', '/i18n/manage/strings', { token: A, body: { language: 'en', app: 'website', entries: { Buy: 'Purchase' } } })).status, 400, 'English is the source');

  // The string list shows what is missing; the export is the file a translator fills in.
  const missing = await api('GET', `/i18n/manage/strings?language=${code}&app=website&filter=missing&search=post%20requirement`, { token: A });
  assert.ok(missing.data.items.some((i) => i.source === 'Post Requirement' && i.value === null));
  const done = await api('GET', `/i18n/manage/strings?language=${code}&app=website&filter=translated`, { token: A });
  assert.equal(done.data.total, 2);
  const file = await (await fetch(`${BASE}/i18n/manage/export?language=${code}&app=website`, { headers: { authorization: `Bearer ${A}` } })).json();
  assert.equal(file['Post Property'], `PP-${RUN}`);
  assert.equal(file['Post Requirement'], '');
  // Removing a translation falls back to English.
  await api('PUT', '/i18n/manage/strings', { token: A, body: { language: code, app: 'website', entries: { 'Post Property': '' } } });
  assert.equal((await api('GET', `/i18n/bundle/${code}?app=website`)).data.strings['Post Property'], undefined);

  // Catalogue import (after a release) adds new text without touching translations.
  const cat = await api('POST', '/i18n/manage/catalogue', { token: A, body: { app: 'crm', strings: [`Fresh label ${RUN}`, 'Dashboard'] } });
  assert.equal(cat.status, 200, JSON.stringify(cat.body));
  assert.equal(cat.data.added, 1);
  assert.equal((await api('GET', '/i18n/bundle/hi?app=crm')).data.strings.Dashboard, 'डैशबोर्ड');
  // The AI helper is optional: without a key it says so rather than failing silently.
  if (!process.env.ANTHROPIC_API_KEY) assert.equal((await api('POST', '/i18n/manage/ai-draft', { token: A, body: { language: code, app: 'website' } })).status, 400);
  await api('POST', '/i18n/manage/languages', { token: A, body: { code, isActive: false } });
  await pool.query('DELETE FROM languages WHERE code = $1', [code]);
  await pool.query(`DELETE FROM i18n_strings WHERE source_text IN ($1, $2)`, [newText, `Fresh label ${RUN}`]);
});

test('privacy (DPDP): consent log, my-data export JSON + CSV, deletion request with 30-day notice, legal hold, anonymisation, events kept without PII', async () => {
  const A = ctx.admin.token;
  // Self-registration logs consent for the six statutory categories.
  const email = `dpdp.${RUN}@e2e.test`;
  const reg = await api('POST', '/auth/register', { body: { fullName: `Dpdp Person ${RUN}`, email, mobile: `95${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, password: PASSWORD, role: 'customer' } });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const uid = reg.data.id;
  await pool.query(`UPDATE users SET status = 'active', email_verified = true WHERE id = $1`, [uid]);
  const U = (await api('POST', '/auth/login', { body: { identifier: email, password: PASSWORD } })).data.accessToken;
  const priv = await api('GET', '/user/privacy', { token: U });
  assert.equal(priv.status, 200, JSON.stringify(priv.body));
  assert.ok(priv.data.consents.upToDate);
  assert.equal(priv.data.consents.items.filter((c) => c.required && c.granted).length, 6);
  // Optional consent can be given and withdrawn; a statutory one cannot be withdrawn piecemeal.
  await api('POST', '/user/consent', { token: U, body: { categories: ['marketing'], granted: true } });
  const off = await api('POST', '/user/consent', { token: U, body: { categories: ['marketing'], granted: false } });
  assert.equal(off.data.items.find((c) => c.category === 'marketing').granted, false);
  assert.equal((await api('POST', '/user/consent', { token: U, body: { categories: ['sharing'], granted: false } })).status, 400);
  await assert.rejects(pool.query(`DELETE FROM consent_logs WHERE user_id = $1`, [uid]), /append-only/);

  // Some data of their own: a requirement, a listing, an event.
  const custId = (await pool.query('SELECT id FROM customers WHERE user_id = $1', [uid])).rows[0]?.id || (await pool.query(`INSERT INTO customers (full_name, email, user_id) VALUES ($1, $2, $3) RETURNING id`, [`Dpdp Person ${RUN}`, email, uid])).rows[0].id;
  await pool.query(`INSERT INTO requirements (customer_id, created_by, purpose, property_type, city, budget_max, notes, fee_consent_at) VALUES ($1, $2, 'buy', 'apartment', 'Delhi', 9000000, 'near my office', now())`, [custId, uid]);
  const listing = (await pool.query(`INSERT INTO properties (created_by, title, property_type, transaction_type, city, price, status) VALUES ($1, $2, 'apartment', 'sell', 'Delhi', '90 Lakh', 'approved') RETURNING id`, [uid, `Dpdp flat ${RUN}`])).rows[0].id;
  await pool.query(`INSERT INTO events (event_id, event_timestamp, event_type, source_track, user_id, customer_id, properties_json, device_json) VALUES (gen_random_uuid(), now(), 'property_view', 'server', $1, $2, $3, '{"browser":"x"}')`, [uid, custId, JSON.stringify({ propertyId: listing, mobile: '9999999999', name: 'Dpdp' })]);

  // My data: JSON and CSV, only for the signed-in person.
  const mine = await api('GET', '/user/my-data', { token: U });
  assert.equal(mine.status, 200, JSON.stringify(mine.body).slice(0, 300));
  assert.equal(mine.data.profile[0].email, email);
  assert.equal(mine.data.requirements.length, 1);
  assert.equal(mine.data.listings[0].title, `Dpdp flat ${RUN}`);
  assert.ok(mine.data.consents.length >= 6 && mine.data.activity.length === 1);
  assert.ok(!JSON.stringify(mine.data).includes('password'), 'no credentials in the export');
  const csv = await fetch(`${BASE}/user/my-data?format=csv`, { headers: { authorization: `Bearer ${U}` } });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const csvText = await csv.text();
  assert.ok(csvText.includes('# requirements') && csvText.includes(email) && csvText.includes(`Dpdp flat ${RUN}`));
  assert.equal((await api('GET', '/user/my-data')).status, 401);
  assert.equal((await api('GET', `/compliance/users/${uid}/data`, { token: A })).status, 403, 'only a Super Admin exports for someone else');
  assert.equal((await api('GET', `/compliance/users/${uid}/data`, { token: ctx.superAdmin.token })).data.profile[0].email, email);

  // Deletion request: 30-day notice, one open request, cancellable.
  const del = await api('POST', '/user/request-deletion', { token: U, body: { reason: 'No longer needed' } });
  assert.equal(del.status, 201, JSON.stringify(del.body));
  assert.match(del.data.requestNumber, /^DR-\d{4}-\d{5}$/);
  const days = (new Date(del.data.dueAt) - Date.now()) / 86400000;
  assert.ok(days > 29 && days <= 30.01, `30-day notice, got ${days}`);
  assert.equal((await api('POST', '/user/request-deletion', { token: U })).data.id, del.data.id, 'idempotent');
  assert.equal((await api('DELETE', '/user/request-deletion', { token: U })).status, 200);
  const del2 = await api('POST', '/user/request-deletion', { token: U });
  const reqId = del2.data.id;
  assert.equal((await api('POST', '/user/request-deletion', { token: ctx.sales.token })).status, 403, 'staff accounts are not self-deleted');

  // Staff queue; nothing happens before the notice ends (except by a Super Admin).
  const queue = await api('GET', '/compliance/data-requests?status=open', { token: ctx.sales.token });
  assert.ok(queue.data.items.some((r) => r.id === reqId && r.daysLeft >= 29));
  assert.equal((await api('POST', `/compliance/data-requests/${reqId}`, { token: ctx.sales.token, body: { action: 'process' } })).status, 403);
  assert.equal((await api('POST', `/compliance/data-requests/${reqId}`, { token: A, body: { action: 'process' } })).status, 400, 'notice not over');

  // Legal hold: an open deal blocks it even after the notice.
  await pool.query(`UPDATE data_requests SET due_at = now() - interval '1 hour' WHERE id = $1`, [reqId]);
  const lead = (await pool.query(`INSERT INTO leads (created_by, source, property_id, customer_id) VALUES ($1, 'manual', $2, $3) RETURNING id`, [ctx.admin.id, listing, custId])).rows[0].id;
  const deal = (await pool.query(`INSERT INTO deals (lead_id, customer_id, property_id, broker_id, stage) VALUES ($1, $2, $3, $4, 'negotiation') RETURNING id`, [lead, custId, listing, ctx.broker.id])).rows[0].id;
  const held = await api('POST', `/compliance/data-requests/${reqId}`, { token: A, body: { action: 'process' } });
  assert.equal(held.data.status, 'on_hold', JSON.stringify(held.body));
  assert.equal(held.data.holdReasons[0].code, 'open_deal');
  assert.equal((await pool.query('SELECT anonymised_at FROM users WHERE id = $1', [uid])).rows[0].anonymised_at, null);

  // Deal closes -> the sweep anonymises.
  await pool.query(`UPDATE deals SET stage = 'closed_lost' WHERE id = $1`, [deal]);
  const run = await api('POST', '/compliance/run', { token: A });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.ok(run.data.privacy.completed >= 1);
  const gone = (await pool.query('SELECT full_name, email, mobile, password_hash, status::text AS status, anonymised_at FROM users WHERE id = $1', [uid])).rows[0];
  assert.equal(gone.full_name, 'Deleted user');
  assert.ok(gone.email.endsWith('@anonymised.invalid') && gone.mobile === null && gone.password_hash === null && gone.status === 'inactive' && gone.anonymised_at);
  assert.equal((await api('POST', '/auth/login', { body: { identifier: email, password: PASSWORD } })).status >= 400, true, 'cannot sign in any more');
  assert.equal((await pool.query('SELECT status::text AS s FROM properties WHERE id = $1', [listing])).rows[0].s, 'inactive', 'listing out of public view');
  assert.equal((await pool.query('SELECT status::text AS s, notes FROM requirements WHERE customer_id = $1', [custId])).rows[0].s, 'closed');
  assert.equal((await pool.query('SELECT full_name FROM customers WHERE id = $1', [custId])).rows[0].full_name, 'Deleted user');
  // The event is still there, without the person.
  const ev = (await pool.query(`SELECT user_id, customer_id, properties_json FROM events WHERE properties_json->>'propertyId' = $1`, [listing])).rows[0];
  assert.ok(ev && ev.user_id === null && ev.customer_id === null);
  assert.equal(ev.properties_json.mobile, undefined);
  assert.equal(ev.properties_json.pii, 'deleted');
  await assert.rejects(pool.query(`UPDATE events SET event_type = 'x' WHERE properties_json->>'propertyId' = $1`, [listing]), /append-only/, 'events stay append-only outside the anonymiser');
  // Consent log and the deal record are kept.
  assert.ok((await pool.query('SELECT COUNT(*)::int AS n FROM consent_logs WHERE user_id = $1', [uid])).rows[0].n >= 6);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM deals WHERE id = $1', [deal])).rows[0].n, 1);
  const done = (await api('GET', '/compliance/data-requests?status=completed', { token: A })).data.items.find((r) => r.id === reqId);
  assert.ok(done && done.summary.listings_delisted === 1 && done.summary.events_anonymised === 1, JSON.stringify(done?.summary));
});

test('compliance alerts: rules open and auto-resolve alerts, acknowledge / dismiss with reason, thresholds and on-off per rule, DPDP due alert', async () => {
  const A = ctx.admin.token;
  const builder = await createUser('builder', 'compbuilder');
  const CCITY = `Comp City ${RUN}`;
  const noRera = (await pool.query(`INSERT INTO properties (created_by, builder_id, title, property_type, transaction_type, city, price, status) VALUES ($1, $1, $2, 'apartment', 'sell', $3, '1 Cr', 'approved') RETURNING id`, [builder.id, `No RERA tower ${RUN}`, CCITY])).rows[0].id;
  const risky = (await pool.query(`INSERT INTO properties (created_by, title, property_type, transaction_type, city, price, status, fraud_band, fraud_score, rera_number) VALUES ($1, $2, 'apartment', 'sell', $3, '1 Cr', 'approved', 'red', 88, 'R1') RETURNING id`, [builder.id, `Risky flat ${RUN}`, CCITY])).rows[0].id;

  assert.equal((await api('GET', '/compliance/summary', { token: ctx.broker.token })).status, 403);
  const run1 = await api('POST', '/compliance/run', { token: ctx.sales.token });
  assert.equal(run1.status, 200, JSON.stringify(run1.body));
  assert.ok(run1.data.opened >= 2);
  const alerts = await api('GET', `/compliance/alerts?search=${encodeURIComponent(RUN)}`, { token: ctx.sales.token });
  const rera = alerts.data.find((a) => a.entityId === noRera && a.ruleKey === 'rera_missing_builder_listing');
  const fraud = alerts.data.find((a) => a.entityId === risky && a.ruleKey === 'fraud_listing_live');
  assert.ok(rera && rera.severity === 'critical' && rera.status === 'open' && rera.link === `/app/properties/${noRera}` && rera.city === CCITY, JSON.stringify(alerts.data));
  assert.ok(fraud && /score 88/.test(fraud.detail));
  assert.ok(alerts.data.some((a) => a.ruleKey === 'professional_unverified_live' && a.entityId === builder.id));
  // Critical ones come first.
  assert.equal(alerts.data[0].severity, 'critical');
  const note = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'compliance'`, [ctx.admin.id]);
  assert.ok(note.rows.length >= 1, 'admins are told about new critical alerts');

  // A second run does not duplicate.
  await api('POST', '/compliance/run', { token: A });
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM compliance_alerts WHERE entity_id = $1`, [noRera])).rows[0].n, 1);

  // Acknowledge (staff); dismiss needs an admin and a reason; a dismissed alert stays quiet.
  assert.equal((await api('POST', `/compliance/alerts/${rera.id}`, { token: ctx.sales.token, body: { action: 'acknowledge' } })).status, 200);
  assert.equal((await api('POST', `/compliance/alerts/${fraud.id}`, { token: ctx.sales.token, body: { action: 'dismiss', note: 'Checked by hand' } })).status, 403);
  assert.equal((await api('POST', `/compliance/alerts/${fraud.id}`, { token: A, body: { action: 'dismiss' } })).status, 400);
  assert.equal((await api('POST', `/compliance/alerts/${fraud.id}`, { token: A, body: { action: 'dismiss', note: 'Documents checked in person - false positive' } })).status, 200);
  await api('POST', '/compliance/run', { token: A });
  const after = await api('GET', `/compliance/alerts?status=all&search=${encodeURIComponent(RUN)}`, { token: A });
  assert.equal(after.data.find((a) => a.id === fraud.id).status, 'dismissed');
  assert.equal(after.data.find((a) => a.id === rera.id).status, 'acknowledged');

  // Fixing the record closes the alert automatically; breaking it again reopens it.
  await pool.query(`UPDATE properties SET rera_number = 'DLRERA2026P0099' WHERE id = $1`, [noRera]);
  await api('POST', '/compliance/run', { token: A });
  const fixed = (await api('GET', `/compliance/alerts?status=resolved&search=${encodeURIComponent(RUN)}`, { token: A })).data.find((a) => a.id === rera.id);
  assert.ok(fixed && fixed.autoResolved);
  await pool.query(`UPDATE properties SET rera_number = NULL WHERE id = $1`, [noRera]);
  await api('POST', '/compliance/run', { token: A });
  assert.equal((await api('GET', `/compliance/alerts?search=${encodeURIComponent(RUN)}`, { token: A })).data.find((a) => a.id === rera.id).status, 'open');

  // Rules: thresholds and on / off (admin only).
  assert.equal((await api('PUT', '/compliance/rules/professional_unverified_live', { token: ctx.sales.token, body: { isActive: false } })).status, 403);
  assert.equal((await api('PUT', '/compliance/rules/professional_unverified_live', { token: A, body: { params: { nope: 1 } } })).status, 400);
  try {
    const up = await api('PUT', '/compliance/rules/professional_unverified_live', { token: A, body: { params: { min_listings: 5 } } });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.ok(!(await api('GET', `/compliance/alerts?rule=professional_unverified_live`, { token: A })).data.some((a) => a.entityId === builder.id), 'below the new threshold');
    await api('PUT', '/compliance/rules/fraud_listing_live', { token: A, body: { isActive: false } });
    assert.equal((await api('GET', '/compliance/alerts?rule=fraud_listing_live', { token: A })).data.length, 0);
  } finally {
    await api('PUT', '/compliance/rules/professional_unverified_live', { token: A, body: { params: { min_listings: 1 } } });
    await api('PUT', '/compliance/rules/fraud_listing_live', { token: A, body: { isActive: true } });
  }

  // DPDP: a deletion request within 5 days of its limit raises a critical alert.
  const person = await createUser('customer', 'compdpdp');
  const dr = await api('POST', '/user/request-deletion', { token: person.token });
  await pool.query(`UPDATE data_requests SET due_at = now() + interval '2 days' WHERE id = $1`, [dr.data.id]);
  await api('POST', '/compliance/run', { token: A });
  const due = (await api('GET', '/compliance/alerts?area=dpdp', { token: A })).data.find((a) => a.entityId === dr.data.id);
  assert.ok(due && due.severity === 'critical' && /due soon/.test(due.title));
  await api('DELETE', '/user/request-deletion', { token: person.token });

  const sum = await api('GET', '/compliance/summary', { token: A });
  assert.equal(sum.data.rules.length, 12);
  assert.ok(sum.data.totals.active >= 1 && sum.data.rules.find((r) => r.ruleKey === 'rera_missing_builder_listing').open >= 1);
  // Leave the local data tidy.
  await pool.query(`UPDATE properties SET status = 'inactive' WHERE id = ANY($1::uuid[])`, [[noRera, risky]]);
  await api('POST', '/compliance/run', { token: A });
});

test('chat: conversation per enquiry with the representative always in it, contact sharing blocked + flagged, masked names, unread counts, immutable messages, masked buyer contact', async () => {
  const A = ctx.admin.token;
  const lister = await createUser('broker', 'chatlister');
  const buyer = await createUser('customer', 'chatbuyer');
  const outsider = await createUser('customer', 'chatout');
  const prop = (await pool.query(`INSERT INTO properties (created_by, broker_id, title, property_type, transaction_type, city, price, status) VALUES ($1, $1, $2, 'apartment', 'sell', $3, '1 Cr', 'approved') RETURNING id`, [lister.id, `Chat flat ${RUN}`, CITY])).rows[0].id;
  const mobile = `94${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const custId = (await pool.query('SELECT id FROM customers WHERE user_id = $1', [buyer.id])).rows[0]?.id
    || (await pool.query(`INSERT INTO customers (full_name, mobile, email, user_id) VALUES ($1, $2, $3, $4) RETURNING id`, [`Chatbuyer Kumar ${RUN}`, mobile, buyer.email, buyer.id])).rows[0].id;
  await pool.query('UPDATE customers SET mobile = $1, full_name = $2 WHERE id = $3', [mobile, `Chatbuyer Kumar ${RUN}`, custId]);
  const lead = (await pool.query(`INSERT INTO leads (created_by, source, property_id, customer_id, assigned_to, arb_rep_id) VALUES ($1, 'website', $2, $3, $4, $5) RETURNING id`, [buyer.id, prop, custId, lister.id, ctx.sales.id])).rows[0].id;

  // The buyer opens the conversation: buyer, lister and the representative are in it.
  assert.ok((await api('GET', '/chat/startable', { token: buyer.token })).data.some((s) => s.leadId === lead));
  assert.equal((await api('POST', '/chat/threads', { token: outsider.token, body: { leadId: lead } })).status, 403);
  const opened = await api('POST', '/chat/threads', { token: buyer.token, body: { leadId: lead } });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const T = opened.data.id;
  assert.equal(opened.data.myParty, 'enquirer');
  assert.deepEqual(opened.data.participants.map((p) => p.party).sort(), ['enquirer', 'lister', 'representative']);
  assert.ok(opened.data.hasRepresentative);
  // The buyer sees the lister by first name only, and no one's number or email.
  const listerSeen = opened.data.participants.find((p) => p.party === 'lister');
  assert.equal(listerSeen.name, 'chatlister');
  assert.ok(!JSON.stringify(opened.data).includes(lister.email) && !JSON.stringify(opened.data).includes(mobile));
  assert.equal((await api('POST', '/chat/threads', { token: lister.token, body: { leadId: lead } })).data.id, T, 'one conversation per enquiry');

  // Messages flow; contact details are rejected before saving and the account is flagged.
  const m1 = await api('POST', `/chat/threads/${T}/messages`, { token: buyer.token, body: { body: 'Is the flat still available? I will contact my bank this week.' } });
  assert.equal(m1.status, 201, JSON.stringify(m1.body));
  for (const bad of ['Call me on 98765 43210', 'mail me at someone@example.com', 'see www.mysite.in for photos', 'whatsapp karo please', 'my number is +91-9876543210']) {
    const r = await api('POST', `/chat/threads/${T}/messages`, { token: buyer.token, body: { body: bad } });
    assert.equal(r.status, 422, `should block: ${bad}`);
  }
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM chat_messages WHERE thread_id = $1', [T])).rows[0].n, 1, 'blocked messages are not stored');
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM user_flags WHERE user_id = $1 AND reason = 'contact_sharing_attempt'`, [buyer.id])).rows[0].n, 1);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM contact_access_log WHERE user_id = $1 AND action = 'message_blocked'`, [buyer.id])).rows[0].n, 5);
  assert.equal((await api('POST', `/chat/threads/${T}/messages`, { token: outsider.token, body: { body: 'hello' } })).status, 403);

  // Unread counts, notifications, reading.
  assert.equal((await api('GET', '/chat/unread', { token: lister.token })).data.messages, 1);
  assert.equal((await api('GET', '/chat/unread', { token: buyer.token })).data.messages, 0);
  assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'chat_message'`, [ctx.sales.id])).rows.length >= 1, 'the representative is told');
  const reply = await api('POST', '/inquiry/send-message', { token: lister.token, body: { leadId: lead, message: 'Yes, it is available. Visits are open on Saturday.' } });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  assert.ok(reply.data.representativeCopied && reply.data.threadId === T);
  const rep = await api('POST', `/chat/threads/${T}/messages`, { token: ctx.sales.token, body: { body: 'I will arrange the visit. Reach me on the platform number 011-40001234.' } });
  assert.equal(rep.status, 201, 'the representative is the contact point and may give the platform number');
  const msgs = await api('GET', `/chat/threads/${T}/messages`, { token: buyer.token });
  assert.deepEqual(msgs.data.items.map((m) => m.party), ['enquirer', 'lister', 'representative']);
  assert.equal(msgs.data.items[1].senderName, 'chatlister', 'first name only for the other side');
  assert.ok(msgs.data.items[0].mine && !msgs.data.items[1].mine);
  const newer = await api('GET', `/chat/threads/${T}/messages?after=${msgs.data.items[1].id}`, { token: buyer.token });
  assert.equal(newer.data.items.length, 1);
  assert.equal((await api('GET', '/chat/threads', { token: buyer.token })).data.find((t) => t.id === T).unread, 2);
  await api('POST', `/chat/threads/${T}/read`, { token: buyer.token });
  assert.equal((await api('GET', '/chat/unread', { token: buyer.token })).data.messages, 0);
  await assert.rejects(pool.query('UPDATE chat_messages SET body = $1 WHERE thread_id = $2', ['edited', T]), /append-only/);

  // Staff oversight: any conversation, and closing it stops further messages.
  assert.ok((await api('GET', '/chat/threads?scope=all', { token: A })).data.some((t) => t.id === T));
  assert.equal((await api('PUT', `/chat/threads/${T}/status`, { token: lister.token, body: { status: 'closed' } })).status, 403);
  assert.equal((await api('PUT', `/chat/threads/${T}/status`, { token: A, body: { status: 'closed', reason: 'Deal moved to the deal room' } })).data.status, 'closed');
  assert.equal((await api('POST', `/chat/threads/${T}/messages`, { token: buyer.token, body: { body: 'hello?' } })).status, 400);

  // Masked buyer contact: assigned representative / admin only, never raw, every look logged.
  assert.equal((await api('GET', `/inquiry/buyer-contact?leadId=${lead}`, { token: lister.token })).status, 403);
  const masked = await api('GET', `/inquiry/buyer-contact?leadId=${lead}`, { token: ctx.sales.token });
  assert.equal(masked.status, 200, JSON.stringify(masked.body));
  assert.equal(masked.data.phone_masked, `${mobile.slice(0, 2)}XXXXXX${mobile.slice(-2)}`);
  assert.ok(!JSON.stringify(masked.data).includes(mobile) && /^.\*@/.test(masked.data.email_masked));
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM contact_access_log WHERE lead_id = $1 AND action IN ('masked_contact_viewed', 'masked_contact_denied')`, [lead])).rows[0].n, 2);
});

test('API ecosystem: API keys with scopes, /v1 with cursor pagination + error format + rate limit + idempotency, masked contact, signed webhooks with retries', async () => {
  const http = require('node:http');
  const A = ctx.admin.token;
  const dev = await createUser('broker', 'apidev');
  const other = await createUser('broker', 'apiother');
  for (let i = 0; i < 3; i += 1) await pool.query(`INSERT INTO properties (created_by, broker_id, title, property_type, transaction_type, city, price, status, created_at) VALUES ($1, $1, $2, 'apartment', 'sell', $3, '1 Cr', 'approved', now() - ($4 || ' minutes')::interval)`, [dev.id, `Api flat ${i} ${RUN}`, CITY, String(i)]);
  const foreign = (await pool.query(`INSERT INTO properties (created_by, broker_id, title, property_type, transaction_type, city, price, status) VALUES ($1, $1, $2, 'apartment', 'sell', $3, '1 Cr', 'approved') RETURNING id`, [other.id, `Other flat ${RUN}`, CITY])).rows[0].id;

  // Keys: customers cannot have one; the key is shown once and stored only as a hash.
  assert.equal((await api('POST', '/developer/keys', { token: ctx.customer.token, body: { name: 'x key', scopes: ['leads:read'] } })).status, 403);
  assert.equal((await api('POST', '/developer/keys', { token: dev.token, body: { name: 'Bad', scopes: ['everything'] } })).status, 400);
  const made = await api('POST', '/developer/keys', { token: dev.token, body: { name: `Website sync ${RUN}`, scopes: ['properties:read', 'leads:read', 'leads:write'] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const KEY = made.data.key;
  assert.match(KEY, /^psk_live_[0-9a-f]{48}$/);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM api_keys WHERE key_hash = $1', [KEY])).rows[0].n, 0, 'the key itself is not stored');
  const listed = await api('GET', '/developer/keys', { token: dev.token });
  assert.ok(listed.data.items.length === 1 && !JSON.stringify(listed.data).includes(KEY));
  const v1 = async (method, path, { key = KEY, body, headers = {} } = {}) => {
    const res = await fetch(`${BASE}/v1${path}`, { method, headers: { ...(key ? { 'x-api-key': key } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };

  // Auth and the error format.
  const noKey = await v1('GET', '/properties', { key: null });
  assert.equal(noKey.status, 401);
  assert.ok(noKey.body.error.code === 'invalid_api_key' && noKey.body.error.status === 401 && noKey.body.error.trace_id && noKey.body.error.timestamp);
  assert.equal((await v1('GET', '/properties', { key: `psk_live_${'0'.repeat(48)}` })).status, 401);
  assert.equal((await v1('GET', '/me')).body.account.id, dev.id);
  const noScope = await v1('GET', '/deals');
  assert.equal(noScope.status, 403);
  assert.equal(noScope.body.error.code, 'missing_scope');

  // Own data only, cursor pagination.
  const p1 = await v1('GET', '/properties?limit=2');
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.ok(p1.body.items.length === 2 && p1.body.has_more && p1.body.total === 3 && p1.body.next_cursor);
  assert.ok(p1.headers.get('x-ratelimit-limit') === '120' && Number(p1.headers.get('x-ratelimit-remaining')) < 120);
  const p2 = await v1('GET', `/properties?limit=2&cursor=${p1.body.next_cursor}`);
  assert.ok(p2.body.items.length === 1 && !p2.body.has_more && p2.body.next_cursor === null);
  assert.equal(new Set([...p1.body.items, ...p2.body.items].map((i) => i.id)).size, 3);
  assert.equal((await v1('GET', `/properties/${foreign}`)).status, 404, 'another broker\'s listing is not visible');
  assert.equal((await v1('GET', '/properties?cursor=garbage')).body.error.code, 'invalid_cursor');

  // Create a lead: validation, idempotency, external id, contact always masked.
  const bad = await v1('POST', '/leads', { body: { full_name: 'X' } });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.error.details.length >= 1);
  const leadMobile = `93${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const body = { full_name: `Api Buyer ${RUN}`, mobile: leadMobile, email: `api.buyer.${RUN}@e2e.test`, property_id: p1.body.items[0].id, message: 'From the partner site', external_id: `ext-${RUN}` };
  const created = await v1('POST', '/leads', { body, headers: { 'idempotency-key': `idem-${RUN}` } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.contact.phone_masked, `${leadMobile.slice(0, 2)}XXXXXX${leadMobile.slice(-2)}`);
  assert.ok(!JSON.stringify(created.body).includes(leadMobile) && !JSON.stringify(created.body).includes(`api.buyer.${RUN}`));
  const replay = await v1('POST', '/leads', { body, headers: { 'idempotency-key': `idem-${RUN}` } });
  assert.ok(replay.status === 201 && replay.body.id === created.body.id && replay.headers.get('idempotent-replayed') === 'true');
  const sameExternal = await v1('POST', '/leads', { body });
  assert.ok(sameExternal.status === 200 && sameExternal.body.id === created.body.id);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM leads WHERE external_lead_id = $1', [`ext-${RUN}`])).rows[0].n, 1);
  assert.equal((await v1('POST', '/leads', { body: { ...body, external_id: 'x2', property_id: foreign } })).status, 422, 'cannot attach someone else\'s listing');
  const leads = await v1('GET', '/leads');
  assert.ok(leads.body.items.some((l) => l.id === created.body.id) && !JSON.stringify(leads.body).includes(leadMobile));

  // Rate limit: per key, per minute.
  const keyId = listed.data.items[0].id;
  assert.equal((await api('PUT', `/developer/keys/${keyId}/rate-limit`, { token: dev.token, body: { perMin: 5 } })).status, 403);
  assert.equal((await api('PUT', `/developer/keys/${keyId}/rate-limit`, { token: A, body: { perMin: 1 } })).status, 200);
  const limited = await v1('GET', '/me');
  assert.equal(limited.status, 429);
  assert.ok(limited.body.error.code === 'rate_limited' && limited.headers.get('retry-after'));
  await api('PUT', `/developer/keys/${keyId}/rate-limit`, { token: A, body: { perMin: 600 } });

  // Webhooks: https only, signed, delivered for the owner's events, retried on failure.
  assert.equal((await api('POST', '/developer/webhooks', { token: dev.token, body: { url: 'ftp://example.com/x', events: ['lead.created'] } })).status, 400);
  assert.equal((await api('POST', '/developer/webhooks', { token: dev.token, body: { url: 'http://127.0.0.1:1/x', events: ['nope'] } })).status, 400);
  const got = [];
  let failNext = false;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      got.push({ headers: req.headers, raw });
      res.statusCode = failNext ? 500 : 200;
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const hook = await api('POST', '/developer/webhooks', { token: dev.token, body: { url: `http://127.0.0.1:${server.address().port}/hook`, events: ['lead.created', 'lead.status_changed'], description: 'e2e' } });
    assert.equal(hook.status, 201, JSON.stringify(hook.body));
    assert.match(hook.data.secret, /^whsec_/);
    assert.ok(!(await api('GET', '/developer/webhooks', { token: dev.token })).data.items[0].secret, 'the secret is shown once');
    const ping = await api('POST', `/developer/webhooks/${hook.data.id}/test`, { token: dev.token });
    assert.ok(ping.data.delivered, JSON.stringify(ping.data));
    const sig = got[0].headers['x-propertyserch-signature'];
    const [, t, v] = sig.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    assert.equal(v, crypto.createHmac('sha256', hook.data.secret).update(`${t}.${got[0].raw}`).digest('hex'), 'signature verifies with the secret');
    assert.equal(got[0].headers['x-propertyserch-event'], 'ping');

    // A new lead of this broker -> lead.created; someone else's lead -> nothing.
    await api('POST', '/developer/webhooks/run', { token: A });
    got.length = 0;
    const l2 = await v1('POST', '/leads', { body: { full_name: `Hook Buyer ${RUN}`, mobile: `92${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` } });
    const otherCust = (await pool.query(`INSERT INTO customers (full_name, mobile, created_by) VALUES ($1, $2, $3) RETURNING id`, [`Other buyer ${RUN}`, `91${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, other.id])).rows[0].id;
    await pool.query(`INSERT INTO leads (created_by, source, property_id, assigned_to, customer_id) VALUES ($1, 'manual', $2, $1, $3)`, [other.id, foreign, otherCust]);
    const run = await api('POST', '/developer/webhooks/run', { token: A });
    assert.ok(run.data.queued >= 1 && run.data.delivered >= 1, JSON.stringify(run.data));
    const events = got.map((g) => JSON.parse(g.raw));
    const mine = events.filter((e) => e.event === 'lead.created');
    assert.equal(mine.length, 1, 'only the owner\'s lead');
    assert.equal(mine[0].data.lead_id, l2.body.id);
    assert.ok(!/mobile|phone|email/.test(got[0].raw), 'no contact details in a webhook');

    // A failing receiver: the event stays pending with a later retry time, then is visible in the delivery log.
    failNext = true;
    await pool.query(`INSERT INTO lead_activity_log (lead_id, user_id, action, details) VALUES ($1, $2, 'status_changed', '{"from":"new","to":"contacted"}')`, [l2.body.id, dev.id]);
    await api('POST', '/developer/webhooks/run', { token: A });
    const log = await api('GET', `/developer/webhooks/${hook.data.id}/deliveries`, { token: dev.token });
    const failed = log.data.find((d) => d.event === 'lead.status_changed');
    assert.ok(failed && failed.status === 'pending' && failed.attempts === 1 && failed.response_code === 500 && new Date(failed.next_attempt_at) > new Date(), JSON.stringify(failed));
    assert.equal((await api('GET', `/developer/webhooks/${hook.data.id}/deliveries`, { token: other.token })).status, 403);
    assert.equal((await api('DELETE', `/developer/webhooks/${hook.data.id}`, { token: dev.token })).status, 200);
  } finally {
    server.close();
  }

  // Revoking a key stops it at once.
  assert.equal((await api('DELETE', `/developer/keys/${keyId}`, { token: dev.token })).status, 200);
  assert.equal((await v1('GET', '/me')).status, 401);
});

test('property exchange: request + indicative valuation, direct swap (Model A) two-sided match, trade-in (Model B), guidance options, linked deals, closing both legs together', async () => {
  const A = ctx.admin.token;
  const XCITY = `Swap City ${RUN}`;
  const YCITY = `Other City ${RUN}`;
  const owner1 = await createUser('customer', 'swapone');
  const owner2 = await createUser('customer', 'swaptwo');
  const builder = await createUser('builder', 'swapbuilder');
  const prop = async (u, title, city, type, beds, price, extra = '') => (await pool.query(
    `INSERT INTO properties (created_by, ${extra ? 'builder_id,' : ''} title, property_type, transaction_type, city, locality, bedrooms, area_sqft, price, price_value, status)
     VALUES ($1, ${extra ? '$1,' : ''} $2, $3, 'sell', $4, 'Central', $5, 1000, 'x', $6, 'approved') RETURNING id`, [u.id, `${title} ${RUN}`, type, city, beds, price])).rows[0].id;
  const flat1 = await prop(owner1, 'Old flat in X', XCITY, 'apartment', 2, 8000000);
  const villa2 = await prop(owner2, 'Villa in Y', YCITY, 'villa', 3, 9000000);
  const newUnit = await prop(builder, 'New tower unit', YCITY, 'villa', 3, 12000000, 'builder');
  await pool.query(`UPDATE properties SET created_at = now() - interval '120 days' WHERE id = $1`, [flat1]);

  // Raise the request: only on your own listing, once per property; the flag is set and a value is given with its basis.
  assert.equal((await api('POST', '/exchange/requests', { token: owner2.token, body: { oldPropertyId: flat1 } })).status, 403);
  const r1 = await api('POST', '/exchange/requests', { token: owner1.token, body: { oldPropertyId: flat1, reinvestmentIntent: 'direct_swap', wantedCity: YCITY, wantedPropertyType: 'villa', wantedBedroomsMin: 3 } });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  const X1 = r1.data.id;
  assert.match(r1.data.requestNumber, /^EX-\d{5}$/);
  assert.equal(r1.data.oldPropertyValuation, 8000000, JSON.stringify(r1.data.valuationBasis));
  assert.ok(['platform', 'asking'].includes(r1.data.valuationSource));
  assert.match(r1.data.guidance.valuationDisclaimer, /[Ii]ndicative/);
  assert.match(r1.data.guidance.disclaimer, /not financial advice/);
  assert.equal((await pool.query('SELECT exchange_intent FROM properties WHERE id = $1', [flat1])).rows[0].exchange_intent, true);
  assert.equal((await api('POST', '/exchange/requests', { token: owner1.token, body: { oldPropertyId: flat1 } })).status, 400, 'one open request per property');
  // Before the other owner asks, there is no swap; the builder unit is a trade-in option; an old listing suggests hold-and-rent.
  const before = r1.data.options.map((o) => o.kind);
  assert.ok(!before.includes('direct_swap') && before.includes('trade_in') && before.includes('hold_and_rent'), JSON.stringify(before));
  const tradeIn = r1.data.options.find((o) => o.kind === 'trade_in').items.find((i) => i.propertyId === newUnit);
  assert.equal(tradeIn.valueDifference, 4000000, 'owner pays the gap');

  // The second owner wants a flat in X: now each has what the other wants -> Model A, shown first.
  const r2 = await api('POST', '/exchange/requests', { token: owner2.token, body: { oldPropertyId: villa2, reinvestmentIntent: 'direct_swap', wantedCity: XCITY, wantedPropertyType: 'apartment' } });
  const X2 = r2.data.id;
  const d1 = await api('GET', `/exchange/requests/${X1}`, { token: owner1.token });
  assert.equal(d1.data.options[0].kind, 'direct_swap');
  assert.equal(d1.data.guidance.recommended[0], 'direct_swap');
  const swap = d1.data.options[0].items[0];
  assert.equal(swap.propertyId, villa2);
  assert.equal(swap.valueDifference, 1000000);
  // Controlled contact: the other owner is never identified.
  const raw = JSON.stringify(d1.data);
  assert.ok(!raw.includes(owner2.email) && !raw.includes(owner2.id) && !/swaptwo/.test(raw), 'no counterparty identity');
  assert.ok(d1.data.representative === null || d1.data.representative.name, 'only the representative is named');
  assert.equal((await api('GET', `/exchange/requests/${X1}`, { token: owner2.token })).status, 403);
  // Out of tolerance (25%): a much dearer property is not offered as a swap.
  await pool.query('UPDATE exchange_requests SET old_property_valuation = 30000000 WHERE id = $1', [X2]);
  assert.ok(!(await api('GET', `/exchange/requests/${X1}`, { token: owner1.token })).data.options.some((o) => o.kind === 'direct_swap'));
  // Staff valuation with its basis replaces it; the owner is told.
  assert.equal((await api('PUT', `/exchange/requests/${X2}/valuation`, { token: owner2.token, body: { value: 9000000, note: 'Registry comparables' } })).status, 403);
  assert.equal((await api('PUT', `/exchange/requests/${X2}/valuation`, { token: A, body: { value: 9000000 } })).status, 422);
  const valued = await api('PUT', `/exchange/requests/${X2}/valuation`, { token: ctx.sales.token, body: { value: 9000000, note: 'Three registry comparables in the same block' } });
  assert.equal(valued.data.valuationSource, 'admin');

  // Owner 1 picks the swap; the representative confirms -> two linked deals, both requests in progress.
  assert.equal((await api('POST', `/exchange/requests/${X1}/interest`, { token: owner1.token, body: { optionKind: 'direct_swap', propertyId: newUnit } })).status, 400, 'not one of the swap options');
  const interest = await api('POST', `/exchange/requests/${X1}/interest`, { token: owner1.token, body: { optionKind: 'direct_swap', propertyId: villa2 } });
  assert.equal(interest.status, 201, JSON.stringify(interest.body));
  assert.equal((await api('GET', '/exchange/summary', { token: A })).data.to_confirm >= 1, true);
  assert.equal((await api('POST', `/exchange/interests/${interest.data.id}/confirm`, { token: owner1.token })).status, 403);
  const confirmed = await api('POST', `/exchange/interests/${interest.data.id}/confirm`, { token: ctx.sales.token });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.data.status, 'in_progress');
  assert.equal(confirmed.data.exchangeType, 'direct_swap');
  assert.equal(confirmed.data.valueDifference, 1000000);
  assert.equal(confirmed.data.legs.length, 2);
  const [legA, legB] = confirmed.data.legs;
  assert.ok(legA.linkedDealId === legB.dealId && legB.linkedDealId === legA.dealId, 'each leg points at the other');
  assert.deepEqual([legA.dealValue, legB.dealValue].sort(), [8000000, 9000000], 'each leg carries its own gross value for the fee');
  const other = await api('GET', `/exchange/requests/${X2}`, { token: owner2.token });
  assert.equal(other.data.status, 'in_progress');
  assert.equal(other.data.valueDifference, -1000000, 'the other owner receives the difference');
  assert.match(other.data.feeNote, /each leg/);

  // Linked closure: one leg cannot close alone; both must be ready; then both close in one step.
  const U = (await pool.query(`SELECT id FROM users WHERE id = $1`, [ctx.admin.id])).rows[0].id;
  await pool.query(`UPDATE deals SET stage = 'payment', sale_deed_execution_date = CURRENT_DATE WHERE id = $1`, [legA.dealId]);
  const alone = await api('PUT', `/deals/${legA.dealId}/stage`, { token: A, body: { stage: 'closed_won', override: true, notes: 'try to close one leg' } });
  assert.ok(alone.status >= 400, 'a single leg cannot be closed');
  assert.equal((await pool.query('SELECT stage::text AS s FROM deals WHERE id = $1', [legA.dealId])).rows[0].s, 'payment');
  const early = await api('POST', `/exchange/requests/${X1}/close`, { token: A });
  assert.equal(early.status, 400);
  assert.match(early.body.message, /Both legs/);
  await pool.query(`UPDATE deals SET stage = 'payment', sale_deed_execution_date = CURRENT_DATE WHERE id = $1`, [legB.dealId]);
  const unpaid = await api('POST', `/exchange/requests/${X1}/close`, { token: A });
  assert.equal(unpaid.status, 400, 'each leg must have its own fee instalments paid');
  for (const [i, leg] of [legA, legB].entries()) {
    const ids = [];
    for (const kind of ['instalment_1', 'instalment_2']) {
      ids.push((await pool.query(
        `INSERT INTO invoices (invoice_number, deal_id, kind, party, gross_value, fee_rate_percent, instalment_percent, fee_amount, gst_type, total_amount, gstin, trigger_date, due_date, status, paid_at, recorded_by)
         VALUES ($1, $2, $3, 'buyer', $4, 1, 50, $5, 'cgst_sgst', $6, '07DERPR1574G2ZY', CURRENT_DATE, CURRENT_DATE + 7, 'paid', now(), $7) RETURNING id`,
        [`EXT-${RUN}-${i}-${kind}`, leg.dealId, kind, leg.dealValue, leg.dealValue * 0.005, leg.dealValue * 0.0059, U])).rows[0].id);
    }
    await pool.query('UPDATE deals SET instalment_1_invoice_id = $1, instalment_2_invoice_id = $2 WHERE id = $3', [ids[0], ids[1], leg.dealId]);
  }
  const closed = await api('POST', `/exchange/requests/${X1}/close`, { token: ctx.sales.token });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.data.status, 'closed');
  assert.deepEqual((await pool.query(`SELECT stage::text AS s FROM deals WHERE id = ANY($1::uuid[])`, [[legA.dealId, legB.dealId]])).rows.map((r) => r.s), ['closed_won', 'closed_won']);
  assert.equal((await api('GET', `/exchange/requests/${X2}`, { token: owner2.token })).data.status, 'closed');
  assert.equal((await pool.query('SELECT exchange_intent FROM properties WHERE id = $1', [flat1])).rows[0].exchange_intent, false);

  // Model B: a trade-in opens two linked legs with the builder; a declined option needs a reason; an open request can be cancelled.
  const owner3 = await createUser('customer', 'swapthree');
  const flat3 = await prop(owner3, 'Idle flat in Y', YCITY, 'apartment', 2, 7000000);
  const r3 = await api('POST', '/exchange/requests', { token: owner3.token, body: { oldPropertyId: flat3, reinvestmentIntent: 'buy_another', wantedCity: YCITY, wantedPropertyType: 'villa' } });
  const t3 = r3.data.options.find((o) => o.kind === 'trade_in');
  assert.ok(t3 && t3.items.some((i) => i.propertyId === newUnit), JSON.stringify(r3.data.options.map((o) => o.kind)));
  const i3 = await api('POST', `/exchange/requests/${r3.data.id}/interest`, { token: owner3.token, body: { optionKind: 'trade_in', propertyId: newUnit } });
  assert.equal((await api('POST', `/exchange/interests/${i3.data.id}/decline`, { token: A, body: {} })).status, 422);
  const c3 = await api('POST', `/exchange/interests/${i3.data.id}/confirm`, { token: A });
  assert.equal(c3.status, 200, JSON.stringify(c3.body));
  assert.equal(c3.data.exchangeType, 'trade_in');
  assert.equal(c3.data.valueDifference, 5000000);
  assert.equal(c3.data.legs.length, 2);
  assert.ok(c3.data.legs.some((l) => l.dealValue === 12000000) && c3.data.legs.some((l) => l.dealValue === 7000000));
  assert.equal((await api('POST', `/exchange/requests/${r3.data.id}/cancel`, { token: owner3.token })).status, 400, 'deals are open - goes through the representative');
  const owner4 = await createUser('customer', 'swapfour');
  const flat4 = await prop(owner4, 'Spare flat', YCITY, 'apartment', 1, 3000000);
  const r4 = await api('POST', '/exchange/requests', { token: owner4.token, body: { oldPropertyId: flat4 } });
  assert.equal((await api('POST', `/exchange/requests/${r4.data.id}/cancel`, { token: owner4.token, body: { reason: 'Changed my mind' } })).data.status, 'cancelled');
  // Positioning rule: the module never says "distressed", "disputed" or "cheap".
  assert.ok(!/distress|disputed|cheap/i.test(JSON.stringify([r1.data, d1.data, r3.data, c3.data])));
  await pool.query(`UPDATE properties SET status = 'inactive' WHERE id = ANY($1::uuid[])`, [[flat1, villa2, newUnit, flat3, flat4]]);
});

// A small JPEG carrying EXIF GPS + DateTimeOriginal, for the WFH photo checks.
function exifJpeg(lat, lng, takenAt, seed = 0) {
  const base = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
  const rat = (v) => { const d = Math.floor(v); const mf = (v - d) * 60; const m = Math.floor(mf); const s = Math.round((mf - m) * 60 * 10000); return [[d, 1], [m, 1], [s, 10000]]; };
  const pad = (x) => String(x).padStart(2, '0');
  const dt = `${takenAt.getFullYear()}:${pad(takenAt.getMonth() + 1)}:${pad(takenAt.getDate())} ${pad(takenAt.getHours())}:${pad(takenAt.getMinutes())}:${pad(takenAt.getSeconds())}\0`;
  // TIFF (little endian): IFD0 -> ExifIFD (DateTimeOriginal) and GPS IFD.
  const ifd0 = 8;
  const exifIfd = ifd0 + 2 + 2 * 12 + 4;
  const gpsIfd = exifIfd + 2 + 1 * 12 + 4;
  const data = gpsIfd + 2 + 4 * 12 + 4;
  const tiff = Buffer.alloc(data + 20 + 24 + 24 + 8);
  tiff.write('II', 0); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(ifd0, 4);
  const entry = (off, tag, type, count, value, inline) => { tiff.writeUInt16LE(tag, off); tiff.writeUInt16LE(type, off + 2); tiff.writeUInt32LE(count, off + 4); if (inline) inline(off + 8); else tiff.writeUInt32LE(value, off + 8); };
  tiff.writeUInt16LE(2, ifd0);
  entry(ifd0 + 2, 0x8769, 4, 1, exifIfd);
  entry(ifd0 + 14, 0x8825, 4, 1, gpsIfd);
  tiff.writeUInt16LE(1, exifIfd);
  entry(exifIfd + 2, 0x9003, 2, 20, data);
  tiff.write(dt, data, 'ascii');
  const latOff = data + 20;
  const lngOff = latOff + 24;
  tiff.writeUInt16LE(4, gpsIfd);
  entry(gpsIfd + 2, 1, 2, 2, 0, (o) => tiff.write(lat >= 0 ? 'N\0' : 'S\0', o, 'ascii'));
  entry(gpsIfd + 14, 2, 5, 3, latOff);
  entry(gpsIfd + 26, 3, 2, 2, 0, (o) => tiff.write(lng >= 0 ? 'E\0' : 'W\0', o, 'ascii'));
  entry(gpsIfd + 38, 4, 5, 3, lngOff);
  rat(Math.abs(lat)).forEach(([a, b], i) => { tiff.writeUInt32LE(a, latOff + i * 8); tiff.writeUInt32LE(b, latOff + i * 8 + 4); });
  rat(Math.abs(lng)).forEach(([a, b], i) => { tiff.writeUInt32LE(a, lngOff + i * 8); tiff.writeUInt32LE(b, lngOff + i * 8 + 4); });
  tiff.writeUInt32LE(seed, tiff.length - 8); // makes each file's bytes differ
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0); app1.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([base.subarray(0, 2), app1, body, base.subarray(2)]);
}

test('WFH citizen-sourcing: join + KYC, task board by distance, 48h lock, GPS / EXIF / phone / OTP checks, rep + staff confirmation, CRM leads, earnings, monthly payout with TDS, forfeits', async () => {
  const A = ctx.admin.token;
  const LAT = 28.6 + (parseInt(RUN.slice(0, 3), 16) % 1000) / 10000;
  const LNG = 77.2 + (parseInt(RUN.slice(3), 16) % 1000) / 10000;
  const near = (m) => LAT + m / 111320; // m metres north
  const WCITY = `Field City ${RUN}`;
  const worker = await createUser('customer', 'fieldone');
  const worker2 = await createUser('customer', 'fieldtwo');
  const mobile = () => `8${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
  const aadhaar = () => String(Math.floor(2e11 + Math.random() * 7e11));
  const form = async (path, token, fields, photos = []) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    photos.forEach((buf, i) => fd.append('photos', new Blob([buf], { type: 'image/jpeg' }), `p${i}.jpg`));
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
    const json = await res.json();
    return { status: res.status, body: json, data: json.data };
  };

  // Amounts are admin-configured, with a city override; they are copied onto a task when it is created.
  assert.equal((await api('PUT', '/wfh/manage/config/buyer_visit_payment_default', { token: ctx.sales.token, body: { value: { amount: 1 } } })).status, 403);
  await api('PUT', '/wfh/manage/config/buyer_visit_payment_default', { token: A, body: { value: { amount: 500, overrides: [{ city: WCITY, amount: 8000 }] } } });
  await api('PUT', '/wfh/manage/config/seller_photo_payment_default', { token: A, body: { value: { amount: 9000 } } });
  await api('PUT', '/wfh/manage/config/requirement_collect_payment_default', { token: A, body: { value: { amount: 300 } } });
  await api('PUT', '/wfh/manage/config/auction_check_payment_default', { token: A, body: { value: { amount: 250 } } });
  try {
    const prop = (await pool.query(`INSERT INTO properties (created_by, title, property_type, transaction_type, city, locality, price, status, latitude, longitude) VALUES ($1, $2, 'apartment', 'sell', $3, 'Field Block', '1 Cr', 'approved', $4, $5) RETURNING id`, [ctx.admin.id, `Field flat ${RUN}`, WCITY, LAT, LNG])).rows[0].id;
    assert.equal((await api('POST', '/wfh/manage/tasks', { token: worker.token, body: { taskType: 'buyer_visit', propertyId: prop } })).status, 403);
    assert.equal((await api('POST', '/wfh/manage/tasks', { token: A, body: { taskType: 'buyer_visit' } })).status, 400, 'a buyer visit needs a listing');
    const made = await api('POST', '/wfh/manage/tasks', { token: ctx.sales.token, body: { taskType: 'buyer_visit', propertyId: prop, count: 2 } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.data[0].paymentAmount, 8000, 'city override');
    const [visitTask, visitTask2] = made.data.map((t) => t.id);
    const photoTask = (await api('POST', '/wfh/manage/tasks', { token: A, body: { taskType: 'seller_photo', latitude: LAT, longitude: LNG, city: WCITY, locality: 'Field Block' } })).data[0].id;
    const reqTask = (await api('POST', '/wfh/manage/tasks', { token: A, body: { taskType: 'requirement_collect', latitude: LAT, longitude: LNG, city: WCITY } })).data[0].id;
    const farTask = (await api('POST', '/wfh/manage/tasks', { token: A, body: { taskType: 'requirement_collect', latitude: LAT + 0.2, longitude: LNG, city: WCITY } })).data[0].id;
    await api('PUT', '/wfh/manage/config/buyer_visit_payment_default', { token: A, body: { value: { amount: 1 } } });
    assert.equal(Number((await pool.query('SELECT payment_amount FROM wfh_tasks WHERE id = $1', [visitTask])).rows[0].payment_amount), 8000, 'a live task keeps its amount');
    await assert.rejects(pool.query('UPDATE wfh_tasks SET payment_amount = 1 WHERE id = $1', [visitTask]), /immutable/);

    // Join: agreement + KYC; details are stored encrypted; browsing is open, accepting waits for KYC.
    const intro = await api('GET', '/wfh/me', { token: worker.token });
    assert.ok(intro.data.joined === false && intro.data.taskTypes.length === 7 && intro.data.agreement.length >= 3);
    const aad = aadhaar();
    const reg = { aadhaar: aad, bankAccount: '123456789012', bankIfsc: 'HDFC0001234', bankAccountName: 'Field One', pan: 'ABCDE1234F', latitude: LAT, longitude: LNG, city: WCITY, locality: 'Field Block' };
    assert.equal((await api('POST', '/wfh/register', { token: worker.token, body: reg })).status, 400, 'agreement must be accepted');
    assert.equal((await api('POST', '/wfh/register', { token: ctx.sales.token, body: { ...reg, agreementAccepted: true } })).status, 400, 'staff cannot join');
    const joined = await api('POST', '/wfh/register', { token: worker.token, body: { ...reg, agreementAccepted: true } });
    assert.equal(joined.status, 201, JSON.stringify(joined.body));
    assert.ok(joined.data.worker.kycStatus === 'pending' && joined.data.worker.aadhaarLast4 === aad.slice(-4) && joined.data.worker.bankAccountLast4 === '9012');
    const stored = (await pool.query('SELECT aadhaar_number_encrypted, bank_account_encrypted FROM wfh_workers WHERE user_id = $1', [worker.id])).rows[0];
    assert.ok(!stored.aadhaar_number_encrypted.includes(aad) && !stored.bank_account_encrypted.includes('123456789012'), 'KYC is encrypted at rest');
    assert.equal((await api('POST', '/wfh/register', { token: worker2.token, body: { ...reg, agreementAccepted: true } })).status, 400, 'one Aadhaar, one field partner');
    const board = await api('GET', '/wfh/board', { token: worker.token });
    assert.ok(board.data.items.some((t) => t.id === visitTask) && !board.data.items.some((t) => t.id === farTask), 'only tasks within 5 km');
    assert.ok(board.data.canAccept === false && /KYC/.test(board.data.blocker));
    const card = board.data.items.find((t) => t.id === visitTask);
    assert.ok(card.distanceKm === 0 && card.paymentAmount === 8000 && card.expiryAt && !('propertyId' in card), 'the card shows locality, pay, distance, expiry - not the property');
    assert.equal((await api('POST', `/wfh/tasks/${visitTask}/accept`, { token: worker.token })).status, 403);
    assert.equal((await api('POST', `/wfh/manage/workers/${worker.id}/kyc`, { token: ctx.sales.token, body: { decision: 'verify' } })).status, 403);
    assert.equal((await api('POST', `/wfh/manage/workers/${worker.id}/kyc`, { token: A, body: { decision: 'verify' } })).data.kycStatus, 'verified');

    // Accept: locked for 48 hours, nobody else can take it.
    const acc = await api('POST', `/wfh/tasks/${visitTask}/accept`, { token: worker.token });
    assert.equal(acc.status, 201, JSON.stringify(acc.body));
    const hours = (new Date(acc.data.lockExpiresAt) - Date.now()) / 3600000;
    assert.ok(hours > 47.9 && hours <= 48.01);
    assert.equal(acc.data.property.title, `Field flat ${RUN}`, 'the property is revealed once the task is theirs');
    await api('POST', '/wfh/register', { token: worker2.token, body: { ...reg, aadhaar: aadhaar(), agreementAccepted: true } });
    await api('POST', `/wfh/manage/workers/${worker2.id}/kyc`, { token: A, body: { decision: 'verify' } });
    assert.equal((await api('POST', `/wfh/tasks/${visitTask}/accept`, { token: worker2.token })).status, 400, 'already taken');
    assert.ok(!(await api('GET', '/wfh/board', { token: worker2.token })).data.items.some((t) => t.id === visitTask));

    // Buyer visit evidence: GPS within 100 m, the buyer's phone (not the worker's own), then the buyer's OTP.
    const A1 = acc.data.id;
    const buyerPhone = mobile();
    const far = await form(`/wfh/assignments/${A1}/submit`, worker.token, { latitude: near(400), longitude: LNG, partyPhone: buyerPhone, partyName: 'Visit Buyer' });
    assert.equal(far.status, 400);
    assert.match(far.body.message, /m from the property/);
    const ownMobile = (await pool.query('SELECT mobile FROM users WHERE id = $1', [worker.id])).rows[0].mobile;
    assert.equal((await form(`/wfh/assignments/${A1}/submit`, worker.token, { latitude: near(40), longitude: LNG, partyPhone: ownMobile, partyName: 'Me' })).status, 400, 'own number refused');
    const sub = await form(`/wfh/assignments/${A1}/submit`, worker.token, { latitude: near(40), longitude: LNG, partyPhone: buyerPhone, partyName: 'Visit Buyer' });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.ok(sub.data.state === 'submitted' && sub.data.waitingFor === 'otp' && sub.data.gpsDistanceM >= 35 && sub.data.gpsDistanceM <= 45 && sub.data.partyPhoneLast4 === buyerPhone.slice(-4));
    const enc = (await pool.query('SELECT buyer_phone_submitted FROM wfh_task_assignments WHERE id = $1', [A1])).rows[0].buyer_phone_submitted;
    assert.ok(enc && !enc.includes(buyerPhone), 'the buyer phone is stored encrypted');
    // The representative cannot confirm before the buyer's OTP; a wrong OTP is refused.
    assert.equal((await api('POST', `/wfh/manage/submissions/${A1}/rep`, { token: A, body: { happened: true } })).status, 400);
    assert.equal((await api('POST', `/wfh/assignments/${A1}/otp`, { token: worker.token, body: { otp: '000000' } })).status, 400);
    const otpOk = await api('POST', `/wfh/assignments/${A1}/otp`, { token: worker.token, body: { otp: sub.data.otp } });
    assert.equal(otpOk.status, 200, JSON.stringify(otpOk.body));
    assert.ok(otpOk.data.otpConfirmed && otpOk.data.waitingFor === 'representative' && otpOk.data.repDueAt);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM wfh_earnings WHERE assignment_id = $1', [A1])).rows[0].n, 0, 'nothing is credited before the representative confirms');
    // Representative confirms -> verified, earning credited, CRM lead tagged WFH-BuyerVisit on the property.
    assert.ok((await api('GET', '/wfh/manage/submissions?queue=pending', { token: ctx.sales.token })).data.some((s) => s.id === A1));
    const repOk = await api('POST', `/wfh/manage/submissions/${A1}/rep`, { token: A, body: { happened: true } });
    assert.equal(repOk.status, 200, JSON.stringify(repOk.body));
    assert.equal(repOk.data.verificationStatus, 'passed');
    const lead = (await pool.query('SELECT source_tag, property_id FROM leads WHERE id = $1', [repOk.data.leadId])).rows[0];
    assert.ok(lead && lead.source_tag === 'WFH-BuyerVisit' && lead.property_id === prop);
    assert.equal((await api('GET', '/wfh/earnings', { token: worker.token })).data.totals.awaitingPayout, 8000);

    // The same buyer cannot be submitted again within 90 days - by anyone.
    const acc2 = await api('POST', `/wfh/tasks/${visitTask2}/accept`, { token: worker2.token });
    const dup = await form(`/wfh/assignments/${acc2.data.id}/submit`, worker2.token, { latitude: near(10), longitude: LNG, partyPhone: buyerPhone, partyName: 'Visit Buyer' });
    assert.equal(dup.status, 400);
    assert.match(dup.body.message, /already been submitted/);
    // "Did not happen" rejects the task, raises the rejection rate and puts the task back on the board.
    const b2 = mobile();
    const sub2 = await form(`/wfh/assignments/${acc2.data.id}/submit`, worker2.token, { latitude: near(10), longitude: LNG, partyPhone: b2, partyName: 'Second Buyer' });
    await api('POST', `/wfh/assignments/${acc2.data.id}/otp`, { token: worker2.token, body: { otp: sub2.data.otp } });
    assert.equal((await api('POST', `/wfh/manage/submissions/${acc2.data.id}/rep`, { token: A, body: { happened: false } })).status, 400, 'a reason is required');
    const no = await api('POST', `/wfh/manage/submissions/${acc2.data.id}/rep`, { token: A, body: { happened: false, reason: 'Buyer says no visit took place' } });
    assert.equal(no.data.verificationStatus, 'failed');
    assert.equal((await pool.query('SELECT status FROM wfh_tasks WHERE id = $1', [visitTask2])).rows[0].status, 'open');
    assert.equal((await api('GET', '/wfh/me', { token: worker2.token })).data.performance.rejectionRate, 100);
    assert.equal((await api('GET', '/wfh/earnings', { token: worker2.token })).data.totals.lifetime, 0);

    // Seller photos: at least 5, each with its own location (within 50 m) and time (last 24 h). No EXIF = refused.
    const pacc = await api('POST', `/wfh/tasks/${photoTask}/accept`, { token: worker.token });
    const P1 = pacc.data.id;
    const sellerPhone = mobile();
    const good = (i) => exifJpeg(near(10 + i), LNG, new Date(Date.now() - 3600000), i + 1);
    assert.equal((await form(`/wfh/assignments/${P1}/submit`, worker.token, { partyPhone: sellerPhone, partyName: 'Owner' }, [0, 1, 2].map(good))).status, 400, 'fewer than 5 photos');
    const plain = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
    const noExif = await form(`/wfh/assignments/${P1}/submit`, worker.token, { partyPhone: sellerPhone, partyName: 'Owner' }, [plain, plain, plain, plain, plain]);
    assert.equal(noExif.status, 400);
    assert.match(noExif.body.message, /no location in the photo/);
    const wrong = await form(`/wfh/assignments/${P1}/submit`, worker.token, { partyPhone: sellerPhone, partyName: 'Owner' }, [0, 1, 2, 3].map(good).concat([exifJpeg(near(900), LNG, new Date(), 9), exifJpeg(near(5), LNG, new Date(Date.now() - 72 * 3600000), 10)]));
    assert.equal(wrong.status, 400, 'a far photo and an old photo do not count');
    assert.match(wrong.body.message, /4 of 6/);
    const psub = await form(`/wfh/assignments/${P1}/submit`, worker.token, { partyPhone: sellerPhone, partyName: 'Owner' }, [0, 1, 2, 3, 4].map(good));
    assert.equal(psub.status, 200, JSON.stringify(psub.body));
    assert.ok(psub.data.photos.length === 5 && psub.data.photos.every((p) => p.distanceM <= 50 && !p.problems.length));
    assert.equal((await api('POST', `/wfh/manage/submissions/${P1}/review`, { token: A, body: { decision: 'approve' } })).status, 400, 'the owner\'s OTP consent comes first');
    await api('POST', `/wfh/assignments/${P1}/otp`, { token: worker.token, body: { otp: psub.data.otp } });
    assert.equal((await api('POST', `/wfh/manage/submissions/${P1}/rep`, { token: A, body: { happened: true } })).status, 400, 'photo tasks go to quality review');
    assert.equal((await api('POST', `/wfh/manage/submissions/${P1}/review`, { token: A, body: { decision: 'reject' } })).status, 400);
    const prev = await api('POST', `/wfh/manage/submissions/${P1}/review`, { token: ctx.sales.token, body: { decision: 'approve' } });
    assert.equal(prev.data.verificationStatus, 'passed');
    assert.equal((await pool.query('SELECT source_tag FROM leads WHERE id = $1', [prev.data.leadId])).rows[0].source_tag, 'WFH-SellerPhoto');

    // Requirement collection: consent + OTP, then verified automatically and a WFH-Requirement lead is created.
    const racc = await api('POST', `/wfh/tasks/${reqTask}/accept`, { token: worker.token });
    const rPhone = mobile();
    assert.equal((await form(`/wfh/assignments/${racc.data.id}/submit`, worker.token, { partyPhone: rPhone, partyName: 'Req Person', propertyType: 'apartment', budgetMax: 9000000 })).status, 400, 'consent required');
    const rsub = await form(`/wfh/assignments/${racc.data.id}/submit`, worker.token, { partyPhone: rPhone, partyName: 'Req Person', propertyType: 'apartment', budgetMax: 9000000, intent: 'buy', consent: true });
    const rdone = await api('POST', `/wfh/assignments/${racc.data.id}/otp`, { token: worker.token, body: { otp: rsub.data.otp } });
    assert.equal(rdone.data.verificationStatus, 'passed', JSON.stringify(rdone.body));
    const rlead = (await pool.query(`SELECT l.source_tag, l.enquiry_type FROM leads l JOIN wfh_task_assignments a ON a.lead_id = l.id WHERE a.id = $1`, [racc.data.id])).rows[0];
    assert.deepEqual([rlead.source_tag, rlead.enquiry_type], ['WFH-Requirement', 'requirement']);

    // Earnings and performance.
    const earn = await api('GET', '/wfh/earnings', { token: worker.token });
    assert.deepEqual([earn.data.totals.lifetime, earn.data.totals.awaitingPayout, earn.data.totals.paidOut], [17300, 17300, 0]);
    assert.equal(earn.data.ledger.length, 3);
    const perf = (await api('GET', '/wfh/me', { token: worker.token })).data.performance;
    assert.ok(perf.completed === 3 && perf.rejectionRate === 0 && perf.streakWeeks === 1 && perf.areas.length >= 1, JSON.stringify(perf));

    // Monthly payout: TDS 5% once the year's total crosses Rs 15,000; UTR recorded; slip PDF; bank details masked.
    assert.equal((await api('POST', '/wfh/manage/payouts/run', { token: ctx.sales.token })).status, 403);
    const run = await api('POST', '/wfh/manage/payouts/run', { token: A, body: {} });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    const mine = run.data.created.find((p) => p.workerId === worker.id);
    assert.deepEqual([mine.gross, mine.tds, mine.net], [17300, 865, 16435]);
    assert.ok(!run.data.created.some((p) => p.workerId === worker2.id), 'nothing verified, nothing paid');
    assert.equal((await api('POST', '/wfh/manage/payouts/run', { token: A, body: {} })).data.created.filter((p) => p.workerId === worker.id).length, 0, 'not paid twice');
    const listed = (await api('GET', '/wfh/manage/payouts?status=pending', { token: A })).data.find((p) => p.id === mine.id);
    assert.ok(listed.bankAccountLast4 === '9012' && !JSON.stringify(listed).includes('123456789012'));
    assert.equal((await api('GET', `/wfh/manage/payouts/${mine.id}/bank`, { token: A })).data.accountNumber, '123456789012', 'full number only on request, and logged');
    assert.equal((await api('POST', `/wfh/manage/payouts/${mine.id}/paid`, { token: A, body: { utr: 'x' } })).status, 422);
    const paid = await api('POST', `/wfh/manage/payouts/${mine.id}/paid`, { token: A, body: { utr: `UTR${RUN}0001` } });
    assert.equal(paid.data.status, 'paid');
    const after = await api('GET', '/wfh/earnings', { token: worker.token });
    assert.deepEqual([after.data.totals.awaitingPayout, after.data.totals.paidOut, after.data.totals.tdsDeducted], [0, 16435, 865]);
    assert.ok(after.data.payouts[0].utr === `UTR${RUN}0001` && after.data.payouts[0].bankAccountLast4 === '9012');
    const slip = await fetch(`${BASE}/wfh/payouts/${mine.id}/slip`, { headers: { authorization: `Bearer ${worker.token}` } });
    assert.equal(Buffer.from(await slip.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.equal((await fetch(`${BASE}/wfh/payouts/${mine.id}/slip`, { headers: { authorization: `Bearer ${worker2.token}` } })).status, 403);

    // A reserved task that runs out of time is a forfeit and goes back on the board.
    const facc = await api('POST', `/wfh/tasks/${visitTask2}/accept`, { token: worker2.token });
    await pool.query(`UPDATE wfh_task_assignments SET lock_expires_at = now() - interval '1 minute' WHERE id = $1`, [facc.data.id]);
    const sweep = await api('POST', '/wfh/manage/sweep', { token: A });
    assert.ok(sweep.data.forfeited >= 1, JSON.stringify(sweep.data));
    assert.equal((await pool.query('SELECT status FROM wfh_tasks WHERE id = $1', [visitTask2])).rows[0].status, 'open');
    assert.ok((await api('GET', '/wfh/me', { token: worker2.token })).data.performance.forfeitRate > 0);
    // A suspended field partner cannot take tasks.
    await api('PUT', `/wfh/manage/workers/${worker2.id}/status`, { token: A, body: { status: 'suspended', note: 'Under review for false submissions' } });
    assert.equal((await api('POST', `/wfh/tasks/${visitTask2}/accept`, { token: worker2.token })).status, 403);
    const sum = await api('GET', '/wfh/manage/summary', { token: ctx.sales.token });
    assert.ok(sum.data.workers >= 2 && sum.data.tasks.verified >= 3);
    await pool.query(`UPDATE wfh_tasks SET status = 'cancelled' WHERE id = ANY($1::uuid[]) AND status = 'open'`, [[visitTask2, farTask]]);
    await pool.query(`UPDATE properties SET status = 'inactive' WHERE id = $1`, [prop]);
  } finally {
    for (const k of ['buyer_visit', 'seller_photo', 'requirement_collect', 'auction_check']) await api('PUT', `/wfh/manage/config/${k}_payment_default`, { token: A, body: { value: { amount: 0, overrides: [] } } });
  }
});

test('document templates: library, only-the-variables form with pre-fill, validation, computed stamp duty + amount in words, state clauses, DOCX + PDF + blank, DRAFT until advocate review, versioning, validators', async () => {
  const zlib = require('node:zlib');
  const A = ctx.admin.token;
  const dl = async (path, token) => { const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } }); return { status: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) }; };
  // The text of a generated .docx (first file entries are stored deflated; document.xml is the last part).
  const docxText = (buf) => {
    const at = buf.indexOf(Buffer.from('word/document.xml'));
    const start = at + 'word/document.xml'.length;
    const size = buf.readUInt32LE(at - 30 + 18);
    return zlib.inflateRawSync(buf.subarray(start, start + size)).toString('utf8').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  };

  // The launch library: all 14 documents, each with its own variables.
  const lib = await api('GET', '/templates', { token: A });
  assert.equal(lib.status, 200, JSON.stringify(lib.body));
  const keys = lib.data.map((t) => t.templateKey);
  for (const k of ['agreement_to_sell', 'sale_deed', 'rent_agreement', 'leave_and_licence', 'memorandum_of_understanding', 'general_power_of_attorney', 'specific_power_of_attorney', 'joint_development_agreement', 'joint_venture_agreement', 'development_agreement', 'builder_buyer_agreement', 'nda_institutional', 'mandate_letter', 'exchange_deed']) assert.ok(keys.includes(k), `missing ${k}`);
  const ats = lib.data.find((t) => t.templateKey === 'agreement_to_sell');
  // Role-based: a customer sees only templates open to everyone; a broker also the professional ones; staff-only stay hidden.
  const custKeys = (await api('GET', '/templates', { token: ctx.customer.token })).data.map((t) => t.templateKey);
  assert.ok(custKeys.includes('rent_agreement') && !custKeys.includes('agreement_to_sell') && !custKeys.includes('nda_institutional'));
  const brokerKeys = (await api('GET', '/templates', { token: ctx.broker.token })).data.map((t) => t.templateKey);
  assert.ok(brokerKeys.includes('agreement_to_sell') && !brokerKeys.includes('mandate_letter'));

  // A deal in a state that has stamp-duty rules: known fields arrive pre-filled.
  const st = (await pool.query(`SELECT s.state_code, s.state_name, r.rate_percent, r.registration_fee_percent, r.registration_fee_cap, c.city_name FROM stamp_duty_rules r JOIN states s ON s.id = r.state_id JOIN cities c ON c.state_id = s.id
    WHERE r.city_id IS NULL AND r.transaction_type = 'sale' AND r.buyer_gender = 'any' AND r.effective_from <= CURRENT_DATE AND (r.effective_until IS NULL OR r.effective_until >= CURRENT_DATE) AND (SELECT COUNT(*) FROM cities c2 WHERE lower(c2.city_name) = lower(c.city_name)) = 1 ORDER BY r.effective_from DESC, c.city_name LIMIT 1`)).rows[0];
  assert.ok(st, 'the geographic master has a stamp-duty rule');
  // The rule the engine must use: a city-level rule overrides the state-wide one.
  const cityId = (await pool.query('SELECT id FROM cities WHERE lower(city_name) = lower($1)', [st.city_name])).rows[0].id;
  const dutyRules = await require('../src/services/geo.service').getStampDutyRules({ stateCode: st.state_code, cityId, transactionType: 'sale' });
  Object.assign(st, dutyRules.find((r) => r.buyer_gender === 'any') || dutyRules[0]);
  const owner = await createUser('customer', 'tplowner');
  const buyerUser = await createUser('customer', 'tplbuyer');
  const prop = (await pool.query(`INSERT INTO properties (created_by, title, property_type, transaction_type, city, locality, address, price, status, area_sqft) VALUES ($1, $2, 'apartment', 'sell', $3, 'Template Block', '12 Template Street', '1.25 Cr', 'approved', 1200) RETURNING id`, [owner.id, `Template flat ${RUN}`, st.city_name])).rows[0].id;
  const cust = (await pool.query('SELECT id FROM customers WHERE user_id = $1', [buyerUser.id])).rows[0]?.id || (await pool.query(`INSERT INTO customers (full_name, email, mobile, user_id) VALUES ($1, $2, $3, $4) RETURNING id`, [`Tpl Buyer ${RUN}`, buyerUser.email, `90${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, buyerUser.id])).rows[0].id;
  await pool.query('UPDATE customers SET full_name = $1, mobile = $2 WHERE id = $3', [`Tpl Buyer ${RUN}`, `90${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, cust]);
  const deal = (await pool.query(`INSERT INTO deals (customer_id, property_id, broker_id, stage, deal_value, assigned_rep_id) VALUES ($1, $2, $3, 'negotiation', 12500000, $4) RETURNING id`, [cust, prop, ctx.broker.id, ctx.sales.id])).rows[0].id;
  const form = await api('GET', `/templates/${ats.id}/form?dealId=${deal}`, { token: ctx.broker.token });
  assert.equal(form.status, 200, JSON.stringify(form.body));
  const field = (n) => form.data.fields.find((f) => f.name === n);
  assert.equal(field('buyer_name').value, `Tpl Buyer ${RUN}`);
  assert.ok(field('buyer_name').prefilled && field('sale_consideration').value === 12500000 && /12 Template Street/.test(field('property_address').value));
  assert.equal(form.data.stateCode, st.state_code);
  assert.ok(!field('token_amount').prefilled && form.data.missing > 0 && form.data.missing < form.data.fields.length, 'only the genuinely missing ones are asked');
  assert.ok(!form.data.fields.some((f) => f.fieldType === 'computed') && form.data.computed.some((c) => c.name === 'stamp_duty_amount'), 'computed variables are not asked');
  // Controlled contact: nothing in the form carries a phone number or an email.
  const buyerMobile = (await pool.query('SELECT mobile FROM customers WHERE id = $1', [cust])).rows[0].mobile;
  assert.ok(!JSON.stringify(form.data).includes(buyerMobile) && !JSON.stringify(form.data).includes(buyerUser.email) && !JSON.stringify(form.data).includes(owner.email));
  // State-specific variables are asked only in their state.
  assert.equal(!!field('khata_number'), st.state_code === 'KA');
  assert.equal((await api('GET', `/templates/${ats.id}/form?dealId=${deal}`, { token: (await createUser('broker', 'tplother')).token })).status, 403, 'not their deal');

  // Per-field validation, then generation with computed figures.
  const values = { execution_date: '2026-11-22', seller_parent_name: 'S/o Ram Kumar', seller_address: '4 Old Road', buyer_parent_name: 'D/o Shyam Lal', buyer_address: '9 New Road', token_amount: 500000, payment_mode: 'cheque', possession_date: '2027-01-15', duty_borne_by: 'Buyer' };
  const bad = await api('POST', `/templates/${ats.id}/generate`, { token: ctx.broker.token, body: { dealId: deal, values: { ...values, token_amount: 'lots', payment_mode: 'cash in a bag', possession_date: 'soon', seller_address: '' } } });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.body.errors.map((e) => e.field).sort(), ['payment_mode', 'possession_date', 'seller_address', 'token_amount']);
  const gen = await api('POST', `/templates/${ats.id}/generate`, { token: ctx.broker.token, body: { dealId: deal, values } });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  assert.ok(/^DOC-\d{4}-\d{6}$/.test(gen.data.documentNumber) && gen.data.templateVersion === 1 && gen.data.draft === true);
  const stored = (await pool.query('SELECT "values", state_code FROM generated_documents WHERE id = $1', [gen.data.id])).rows[0];
  const expectedDuty = Math.round(12500000 * Number(st.rate_percent) / 100);
  assert.equal(stored.values.stamp_duty_amount, expectedDuty, 'stamp duty from the state rule');
  const fee = 12500000 * Number(st.registration_fee_percent) / 100;
  assert.equal(stored.values.registration_fee_amount, Math.round(st.registration_fee_cap === null ? fee : Math.min(fee, Number(st.registration_fee_cap))));
  assert.equal(stored.values.sale_consideration_words, 'Rupees One Crore Twenty Five Lakh Only');
  assert.equal(stored.values.buyer_name, `Tpl Buyer ${RUN}`, 'known values need not be retyped');

  // DOCX and PDF with every variable merged, the disclaimer, and DRAFT until advocate review.
  const docx = await dl(`/templates/generated/${gen.data.id}/download?format=docx`, ctx.broker.token);
  assert.ok(docx.status === 200 && /wordprocessingml/.test(docx.type) && docx.buf.subarray(0, 2).toString() === 'PK');
  const text = docxText(docx.buf);
  assert.ok(text.includes(`Tpl Buyer ${RUN}`) && text.includes('Rs. 1,25,00,000/-') && text.includes('Rupees One Crore Twenty Five Lakh Only') && text.includes('22nd day of November, 2026') && text.includes('S/o Ram Kumar'), text.slice(0, 600));
  assert.ok(text.includes(`Rs. ${expectedDuty.toLocaleString('en-IN')}/-`), 'the stamp duty figure is in the document');
  assert.ok(text.includes("Working draft for the client's chosen advocate to review, stamp, and register before execution."));
  assert.ok(text.includes('DRAFT - NOT FOR EXECUTION') && !/\{\{/.test(text), 'no unmerged placeholders');
  assert.ok(!text.includes(buyerMobile) && !text.includes(buyerUser.email));
  const pdf = await dl(`/templates/generated/${gen.data.id}/download?format=pdf`, ctx.broker.token);
  assert.ok(pdf.type === 'application/pdf' && pdf.buf.subarray(0, 4).toString() === '%PDF');
  // Access: the counterparty and outsiders cannot fetch it.
  assert.equal((await dl(`/templates/generated/${gen.data.id}/download`, buyerUser.token)).status, 403);
  assert.equal((await dl(`/templates/generated/${gen.data.id}/download`, owner.token)).status, 403);
  // Advocate review: staff only (the assigned rep or an admin); the watermark then comes off.
  assert.equal((await api('POST', `/templates/generated/${gen.data.id}/advocate-reviewed`, { token: ctx.broker.token })).status, 403);
  const reviewed = await api('POST', `/templates/generated/${gen.data.id}/advocate-reviewed`, { token: ctx.sales.token });
  assert.equal(reviewed.data.draft, false, JSON.stringify(reviewed.body));
  assert.ok(!docxText((await dl(`/templates/generated/${gen.data.id}/download?format=docx`, ctx.broker.token)).buf).includes('DRAFT - NOT FOR EXECUTION'));
  const pdf2 = await dl(`/templates/generated/${gen.data.id}/download?format=pdf`, ctx.broker.token);
  assert.ok(pdf2.buf.length < pdf.buf.length, 'the PDF no longer carries the watermark');

  // Blank version: underlined blanks, no values needed.
  const blank = await api('POST', `/templates/${ats.id}/generate`, { token: ctx.broker.token, body: { blank: true } });
  assert.equal(blank.status, 201, JSON.stringify(blank.body));
  const blankText = docxText((await dl(`/templates/generated/${blank.data.id}/download?format=docx`, ctx.broker.token)).buf);
  assert.ok(blankText.includes('________________') && !blankText.includes(`Tpl Buyer ${RUN}`) && !/\{\{/.test(blankText));
  // Every generation is in the immutable audit log with the template version.
  const log = (await pool.query(`SELECT after_json FROM audit_logs WHERE action = 'template.document_generated' AND entity_id = $1`, [gen.data.id])).rows[0];
  assert.ok(log && log.after_json.templateVersion === 1 && log.after_json.dealId === deal);

  // Admin: a new document type with no code change; validators run on the text; variables must be defined.
  assert.equal((await api('POST', '/templates', { token: ctx.broker.token, body: { name: 'x', body: 'x'.repeat(50) } })).status, 403);
  const tplBody = `# Receipt ${RUN}\n\nReceived from {{payer_name}} a sum of {{amount}} ({{amount_words}}) on {{receipt_date}} towards {{purpose}}.`;
  const vars = [{ name: 'payer_name', label: 'Received from', fieldType: 'text', prefill: 'deal.buyer_name' }, { name: 'amount', label: 'Amount', fieldType: 'currency', validation: { min: 1 } }, { name: 'amount_words', fieldType: 'computed', computed: { kind: 'amount_in_words', of: 'amount' } },
    { name: 'receipt_date', label: 'Date', fieldType: 'date' }, { name: 'purpose', label: 'Towards', fieldType: 'dropdown', options: ['token amount', 'balance consideration'] }];
  assert.equal((await api('POST', '/templates', { token: A, body: { name: `Receipt ${RUN}`, body: `${tplBody} Call me on 9876543210.`, variables: vars } })).status, 422, 'contact details in a template are refused');
  assert.equal((await api('POST', '/templates', { token: A, body: { name: `Receipt ${RUN}`, body: `${tplBody} Sold to a distressed seller.`, variables: vars } })).status, 422, 'forbidden terms are refused');
  const undefinedVar = await api('POST', '/templates', { token: A, body: { name: `Receipt ${RUN}`, body: tplBody, variables: vars.slice(0, 3) } });
  assert.equal(undefinedVar.status, 400);
  assert.match(undefinedVar.body.message, /receipt_date/);
  const made = await api('POST', '/templates', { token: A, body: { name: `Receipt ${RUN}`, category: 'general', audience: 'professional', body: tplBody, variables: vars } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.ok(made.data.status === 'draft' && made.data.currentVersion === 1);
  assert.ok(!(await api('GET', '/templates', { token: ctx.broker.token })).data.some((t) => t.id === made.data.id), 'a draft is not offered yet');
  await api('PUT', `/templates/${made.data.id}/status`, { token: A, body: { status: 'active' } });
  const r1 = await api('POST', `/templates/${made.data.id}/generate`, { token: ctx.broker.token, body: { values: { payer_name: 'Asha Rao', amount: 250000, receipt_date: '2026-10-07', purpose: 'token amount' } } });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  // An edit makes version 2; the earlier document still renders from version 1.
  const v2 = await api('POST', '/templates', { token: A, body: { id: made.data.id, body: tplBody.replace('Received from', 'RECEIVED WITH THANKS from'), variables: vars, changeNote: 'Wording' } });
  assert.equal(v2.data.currentVersion, 2);
  assert.deepEqual(v2.data.history.map((h) => h.version), [2, 1]);
  await assert.rejects(pool.query(`UPDATE document_template_versions SET body = 'x' WHERE template_id = $1`, [made.data.id]), /immutable/);
  const r2 = await api('POST', `/templates/${made.data.id}/generate`, { token: ctx.broker.token, body: { values: { payer_name: 'Asha Rao', amount: 250000, receipt_date: '2026-10-07', purpose: 'token amount' } } });
  assert.equal(r2.data.templateVersion, 2);
  const oldText = docxText((await dl(`/templates/generated/${r1.data.id}/download?format=docx`, ctx.broker.token)).buf);
  const newText = docxText((await dl(`/templates/generated/${r2.data.id}/download?format=docx`, ctx.broker.token)).buf);
  assert.ok(oldText.includes('Received from Asha Rao') && !oldText.includes('RECEIVED WITH THANKS') && newText.includes('RECEIVED WITH THANKS from Asha Rao') && newText.includes('Rupees Two Lakh Fifty Thousand Only'));
  // Retired: no longer offered or generated.
  await api('PUT', `/templates/${made.data.id}/status`, { token: A, body: { status: 'retired' } });
  assert.equal((await api('POST', `/templates/${made.data.id}/generate`, { token: ctx.broker.token, body: { blank: true } })).status, 404);
  assert.ok((await api('GET', `/templates/generated?dealId=${deal}`, { token: ctx.sales.token })).data.some((g) => g.id === gen.data.id));
  await pool.query(`UPDATE properties SET status = 'inactive' WHERE id = $1`, [prop]);
});

test('advanced search: full-text + typo tolerance, autocomplete, did-you-mean, geo radius + distance, area / trust / urgency / deal-type filters, facets, ranking with sponsored boost and match score, saved-search alert', async () => {
  const A = ctx.admin.token;
  const SCITY = `Searchpur ${RUN}`;
  const LAT = 19.1 + (parseInt(RUN.slice(0, 3), 16) % 1000) / 10000;
  const LNG = 72.8 + (parseInt(RUN.slice(3), 16) % 1000) / 10000;
  const lister = await createUser('broker', 'searchlister');
  const add = async (title, extra = {}) => {
    const p = { locality: 'Lakeview Enclave', property_type: 'apartment', bedrooms: 2, area: 900, price: 8000000, lat: LAT, lng: LNG, verified: false, furnishing: 'furnished', description: 'A bright home', tags: '[]', badge: null, days: 0, tx: 'sell', ...extra };
    return (await pool.query(
      `INSERT INTO properties (created_by, broker_id, title, description, property_type, transaction_type, city, locality, price, price_value, bedrooms, area_sqft, status, latitude, longitude, is_verified, furnishing, tags, badge, created_at)
       VALUES ($1, $1, $2, $3, $4::property_type, $5::transaction_type, $6, $7, 'x', $8, $9, $10, 'approved', $11, $12, $13, $14, $15::jsonb, $16, now() - ($17 || ' days')::interval) RETURNING id`,
      [lister.id, `${title} ${RUN}`, p.description, p.property_type, p.tx, SCITY, p.locality, p.price, p.bedrooms, p.area, p.lat, p.lng, p.verified, p.furnishing, p.tags, p.badge, String(p.days)])).rows[0].id;
  };
  const near = (km) => LAT + km / 111;
  const sunrise = await add('Sunrise Heights', { description: 'Corner flat with a jacuzzi and lake view', days: 30 });
  const maple = await add('Maple Residency', { locality: 'Orchard Road', bedrooms: 3, area: 1500, price: 15000000, lat: near(2), verified: true, furnishing: 'semi-furnished', days: 1 });
  const cedar = await add('Cedar Villa', { property_type: 'villa', bedrooms: 4, area: 3200, price: 42000000, lat: near(12), tags: '["Urgent sale"]', days: 10 });
  const birch = await add('Birch Studio', { bedrooms: 1, area: 450, price: 2000000, lat: near(40), tx: 'rent', days: 5 });
  const q = async (qs, token) => (await api('GET', `/search/properties?city=${encodeURIComponent(SCITY)}&${qs}`, { token })).data;
  const ids = (d) => d.items.map((i) => i.id);

  // Full-text across title, locality and description; typing mistakes still find it.
  assert.deepEqual(ids(await q('q=sunrise')), [sunrise]);
  assert.deepEqual(ids(await q('q=jacuzzi')), [sunrise], 'a word from the description');
  assert.deepEqual(ids(await q('q=Sunrize%20Hieghts')), [sunrise], 'typo tolerant');
  assert.deepEqual(ids(await q('q=orchrad')), [maple], 'typo in the locality');
  assert.equal((await q('q=zzzzqqq')).items.length, 0);

  // Dictionary: autocomplete with typos, and "did you mean" when nothing is found.
  assert.equal((await api('POST', '/search/reindex', { token: ctx.broker.token })).status, 403);
  const re = await api('POST', '/search/reindex', { token: A });
  assert.ok(re.data.terms > 3, JSON.stringify(re.body));
  const sug = await api('GET', `/search/suggestions?q=${encodeURIComponent(`Serchpur ${RUN}`)}`);
  assert.ok(sug.data.some((s) => s.value === SCITY && s.type === 'city'), JSON.stringify(sug.data));
  const sug2 = await api('GET', '/search/suggestions?q=lakevew');
  assert.ok(sug2.data.some((s) => s.value === 'Lakeview Enclave'), JSON.stringify(sug2.data));
  const none = (await api('GET', `/search/properties?q=${encodeURIComponent(`Mapel Residancy ${RUN}`)}&minPrice=999999999999`)).data;
  assert.equal(none.items.length, 0);
  assert.equal(none.didYouMean?.term, `Maple Residency ${RUN}`, JSON.stringify(none.didYouMean));

  // Geo-search: radius from a point, nearest first, distance returned.
  const geo = await q(`lat=${LAT}&lng=${LNG}&radiusKm=5`);
  assert.deepEqual(ids(geo), [sunrise, maple], 'within 5 km, nearest first');
  assert.ok(geo.items[0].distance_km < 0.2 && Math.abs(geo.items[1].distance_km - 2) < 0.2, JSON.stringify(geo.items.map((i) => i.distance_km)));
  assert.equal(geo.search.sort, 'distance');
  assert.deepEqual(ids(await q(`lat=${LAT}&lng=${LNG}&radiusKm=20`)), [sunrise, maple, cedar]);
  assert.equal((await api('GET', `/search/properties?lat=${LAT}&lng=${LNG}&radiusKm=1&city=${encodeURIComponent(SCITY)}`)).data.items.length, 1);
  assert.equal((await api('GET', '/search/properties?lat=200&lng=10')).status, 422);

  // Smart filters: area, lister trust score, urgency, deal type, furnishing.
  assert.deepEqual(ids(await q('minArea=1000&maxArea=2000')), [maple]);
  assert.deepEqual(ids(await q('urgency=urgent')), [cedar]);
  assert.deepEqual(ids(await q('dealType=rent')), [birch]);
  assert.equal((await q('dealType=sale')).items.length, 3);
  assert.deepEqual(ids(await q('furnishing=semi-furnished')), [maple]);
  assert.equal((await q('minTrust=1')).items.length, 0, 'no trust score yet');
  await pool.query(`INSERT INTO trust_scores (user_id, score, components, inputs, search_boost) VALUES ($1, 82, '{}', '{}', 8) ON CONFLICT (user_id) DO UPDATE SET score = 82, search_boost = 8`, [lister.id]);
  assert.equal((await q('minTrust=80')).items.length, 4);
  assert.equal((await q('minTrust=90')).items.length, 0);

  // Facets: counts for the filters in force.
  const fac = await q('facets=true&dealType=sale');
  assert.deepEqual(fac.facets.propertyType, [{ value: 'apartment', count: 2 }, { value: 'villa', count: 1 }]);
  assert.deepEqual(fac.facets.bedrooms.map((b) => [b.label, b.count]), [['2', 1], ['3', 1], ['4', 1]]);
  assert.ok(fac.facets.locality.some((l) => l.value === 'Lakeview Enclave' && l.count === 2) && fac.facets.verified === 1);
  assert.deepEqual(fac.facets.priceBand.map((b) => b.value), ['50l_1cr', '1cr_2cr', '2cr_5cr']);

  // Ranking: verification level + recency put the newer verified listing first; rank scores are returned.
  const ranked = await q('dealType=sale');
  assert.equal(ranked.items[0].id, maple, JSON.stringify(ranked.items.map((i) => [i.title, i.rank_score])));
  assert.ok(ranked.items.every((i, n, arr) => n === 0 || arr[n - 1].rank_score >= i.rank_score));
  assert.equal(ranked.items[0].sponsored, null);

  // Sponsored boost: a live Sponsored campaign lifts its listing to the top, labelled, and counts one impression per viewer per day.
  const advUser = await createUser('broker', 'searchadv');
  const adv = (await pool.query(`INSERT INTO advertisers (av_code, user_id, business_name, business_category, contact_email, source) VALUES ($1, $2, $3, 'broker_firm', $4, 'outbound') RETURNING id`, [`AV-S${RUN}`, advUser.id, `Search Ads ${RUN}`, advUser.email])).rows[0].id;
  const camp = (await pool.query(
    `INSERT INTO ad_campaigns (advertiser_id, name, format_key, placements, property_id, targeting, start_date, end_date, units, pricing_unit, rate, amount, status)
     VALUES ($1, $2, 'search_sponsored', '["search_sponsored"]', $3, $4, CURRENT_DATE, CURRENT_DATE + 30, 1, 'month', 0, 0, 'approved') RETURNING id`,
    [adv, `Boost ${RUN}`, cedar, JSON.stringify({ cities: [SCITY] })])).rows[0].id;
  const boosted = await q('dealType=sale&viewer=viewer-1');
  assert.equal(boosted.items[0].id, cedar, 'sponsored first');
  assert.deepEqual([boosted.items[0].sponsored.label, boosted.items[0].sponsored.campaignId], ['Sponsored', camp]);
  assert.equal(boosted.items[1].sponsored, null);
  await q('dealType=sale&viewer=viewer-1');
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM ad_events WHERE campaign_id = $1 AND kind = 'impression'`, [camp])).rows[0].n, 1, 'one impression per viewer per day');
  // Not boosted for a search it does not target, or under an explicit price sort.
  assert.equal((await q('dealType=sale&sort=price_asc')).items[0].id, sunrise);
  await pool.query(`UPDATE ad_campaigns SET status = 'ended' WHERE id = $1`, [camp]);
  assert.equal((await q('dealType=sale')).items[0].id, maple);

  // Match score: a signed-in buyer's own requirement match lifts that listing.
  const buyer = await createUser('customer', 'searchbuyer');
  const cust = (await pool.query('SELECT id FROM customers WHERE user_id = $1', [buyer.id])).rows[0]?.id || (await pool.query(`INSERT INTO customers (full_name, email, user_id) VALUES ($1, $2, $3) RETURNING id`, [`Search buyer ${RUN}`, buyer.email, buyer.id])).rows[0].id;
  const reqId = (await pool.query(`INSERT INTO requirements (customer_id, created_by, purpose, property_type, city, budget_max, fee_consent_at) VALUES ($1, $2, 'buy', 'apartment', $3, 9000000, now()) RETURNING id`, [cust, buyer.id, SCITY])).rows[0].id;
  await pool.query(`INSERT INTO requirement_matches (requirement_id, property_id, score, rank_score, tier, breakdown) VALUES ($1, $2, 96, 96, 'hot', '{}')`, [reqId, sunrise]);
  const forBuyer = await q('dealType=sale', buyer.token);
  assert.equal(forBuyer.items[0].id, sunrise, JSON.stringify(forBuyer.items.map((i) => [i.title, i.rank_score, i.match_score])));
  assert.equal(forBuyer.items[0].match_score, 96);
  assert.equal((await q('dealType=sale')).items[0].match_score, null, 'no match score for an anonymous visitor');

  // Saved search with the new filters -> alert when a new listing fits (and not when it is outside the radius).
  const saved = await api('POST', '/me/saved-searches', { token: buyer.token, body: { name: `Near the lake ${RUN}`, filters: { purpose: 'buy', city: SCITY, lat: LAT, lng: LNG, radiusKm: 3, minArea: 800 } } });
  assert.ok(saved.status === 201 || saved.status === 200, JSON.stringify(saved.body));
  const fits = await add('Willow Court', { area: 1000, lat: near(1) });
  const far = await add('Faraway Court', { area: 1000, lat: near(30) });
  const portal = require('../src/services/portal.service');
  await portal.notifyNewListing(fits);
  await portal.notifyNewListing(far);
  const alerts = (await pool.query(`SELECT related_entity_id FROM notifications WHERE user_id = $1 AND type = 'saved_search_alert'`, [buyer.id])).rows.map((r) => r.related_entity_id);
  assert.deepEqual(alerts, [fits]);
  await pool.query(`UPDATE properties SET status = 'inactive' WHERE id = ANY($1::uuid[])`, [[sunrise, maple, cedar, birch, fits, far]]);
});
