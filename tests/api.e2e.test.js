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
  const noConsent = await api('POST', '/me/listings', { token: seller.token, body: { ...listingBody, feeConsent: false } });
  assert.equal(noConsent.status, 400);
  const withPhone = await api('POST', '/me/listings', { token: seller.token, body: { ...listingBody, title: 'Call 9876543210 now', feeConsent: true } });
  assert.equal(withPhone.status, 422);
  const listing = await api('POST', '/me/listings', { token: seller.token, body: { ...listingBody, feeConsent: true, mandateType: 'exclusive' } });
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
    body: { purpose: 'buy', propertyType: 'apartment', city: CITY, localities: ['Sector 56'], budgetMin: 10000000, budgetMax: 20000000, bedrooms: 3, urgency: 'immediate', feeConsent: true },
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
      city: CITY, locality: 'Sector 1', feeConsent: true, situationTags: ['urgent_sale', 'investor_exit'], estimatedMarketValue: 11000000,
    },
  });
  assert.equal(listing.status, 201);
  const row = (await pool.query('SELECT listing_category, opportunity_source_type, situation_tags, discount_percent FROM properties WHERE id = $1', [listing.data.id])).rows[0];
  assert.equal(row.listing_category, 'special_situation');
  assert.equal(row.opportunity_source_type, 'direct_seller');
  assert.deepEqual(row.situation_tags, ['urgent_sale', 'investor_exit']);
  assert.ok(Number(row.discount_percent) > 0);
  assert.equal((await api('POST', '/me/listings', { token: plain.token, body: { title: 'Bad tag listing', propertyType: 'apartment', transactionType: 'sell', price: '100', city: CITY, locality: 'X', feeConsent: true, situationTags: ['distressed'] } })).status, 422);
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
      areaMinSqft: 1200, areaMaxSqft: 1800, amenities: ['gym', 'pool'], urgency: 'immediate', feeConsent: true,
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
  await api('PUT', `/properties/${listing.data.id}`, { token: A, body: { mandateType: 'exclusive' } });
  const mandated = await api('GET', '/trust/me?refresh=true', { token: broker.token });
  assert.ok(mandated.data.badges.some((b) => b.badge_key === 'exclusive_mandate'));
  assert.equal(mandated.data.inputs.mandateBonus, 5);
  await api('PUT', `/properties/${listing.data.id}`, { token: A, body: { mandateType: 'standard' } });
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
  assert.ok(queue.data.listings.some((l) => l.id === red.data.id && l.review_due_at));
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
    body: { title: `NRI owned flat ${RUN}`, propertyType: 'apartment', transactionType: 'sell', price: '95 Lakh', city: DCITY, locality: 'Delta', feeConsent: true },
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

  // Dependency enforcement: no visit, no site_visit stage; broker cannot override.
  const blocked = await api('PUT', `/deals/${D}/stage`, { token: broker.token, body: { stage: 'site_visit' } });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.message, /site visit/i);
  assert.equal((await api('PUT', `/deals/${D}/stage`, { token: broker.token, body: { stage: 'site_visit', override: true, notes: 'x' } })).status, 403);
  const v0 = await view();
  assert.equal(v0.data.next, 'site_visit');
  assert.equal(v0.data.nextRequirements[0].met, false);

  // Auto-advance: visit scheduled -> site_visit; completed -> negotiation; value -> booking.
  const visit = await api('POST', `/deals/${D}/site-visit`, { token: broker.token, body: { scheduledAt: new Date(Date.now() + 86400000).toISOString() } });
  assert.equal((await evaluate()).data.stage, 'site_visit');
  await api('PUT', `/deals/${D}/site-visit/${visit.data.id}`, { token: broker.token, body: { status: 'completed', actualVisitAt: new Date().toISOString() } });
  assert.equal((await evaluate()).data.stage, 'negotiation');
  await api('PUT', `/deals/${D}`, { token: broker.token, body: { dealValue: 10000000 } });
  const booked = await evaluate();
  assert.equal(booked.data.stage, 'booking');
  assert.equal(booked.data.next, 'documentation');

  // Execution dates: no Sale Deed before ATS, no future dates.
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await api('PUT', `/orchestration/deals/${D}/dates`, { token: broker.token, body: { saleDeedExecutionDate: today } })).status, 400);
  assert.equal((await api('PUT', `/orchestration/deals/${D}/dates`, { token: broker.token, body: { atsExecutionDate: '2999-01-01' } })).status, 400);
  const ats = await api('PUT', `/orchestration/deals/${D}/dates`, { token: broker.token, body: { atsExecutionDate: today } });
  assert.equal(ats.status, 200, JSON.stringify(ats.body));
  assert.equal(ats.data.stage, 'documentation');
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
  assert.equal(Math.round((new Date(inv1.due_date) - new Date(today)) / 86400000), 7, 'net 7');
  assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'invoice'`, [buyer.id])).rows.length, 'buyer notified');

  // Signed agreement approved -> payment.
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
  assert.equal((await api('PUT', `/deals/${D2}/stage`, { token: A, body: { stage: 'site_visit', override: true } })).status, 400, 'override needs a reason');
  const over = await api('PUT', `/deals/${D2}/stage`, { token: A, body: { stage: 'site_visit', override: true, notes: 'Visit done offline, proof on file' } });
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
  assert.ok(intel.data.conversion.byCity.some((c) => c.key === OCITY && c.won >= 1));
  assert.ok(intel.data.atRisk.some((d) => d.id === D2));
  assert.ok(intel.data.recommendations.some((r) => r.dealId === D2));
  const mine = await api('GET', '/orchestration/intelligence', { token: broker.token });
  assert.equal(mine.data.scope, 'mine');
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
