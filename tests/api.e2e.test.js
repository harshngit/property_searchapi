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
  assert.equal(listing.data.status, 'pending_approval');
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
  assert.equal(edited.data.status, 'pending_approval', 'edits go back through approval');
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
