const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const market = require('./market.service');
const { getReadUrl } = require('../utils/storage');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Module 45 - Property Exchange Engine.
//
//   1  The owner raises a request on a listing of theirs: what they have,
//      what they want instead, and what they intend to do (the
//      reinvestment questionnaire).
//   2  The old property gets an indicative valuation from platform data
//      (staff may replace it with their own). Always with the disclaimer.
//   3  Options are worked out: a direct swap with another owner whose
//      property fits and who wants this one (Model A), a trade-in against
//      builder stock (Model B), and the other paths - upgrade, reinvest in
//      a special-situation / auction property, downsize and keep the rest,
//      or hold and rent. Each shows the value gap or surplus.
//   4  The owner marks the option they want; their A R Buildwel
//      representative confirms it, which opens the deals.
//   5  An exchange is two ordinary deals linked to each other. Each leg
//      carries its own 1% + GST professional fee on the usual two
//      instalments (Module 40), and both legs close together. The value
//      difference is settled between the parties off-platform; no escrow.
//
// Owners never see each other's identity or contact: options show the
// property (type, locality, value) only, and everything goes through the
// representative. Copy rule for this module: say "stuck-up", "idle" or
// "hard-to-move".

const STAFF = ['internal_sales', 'admin', 'super_admin'];
const isStaff = (u) => STAFF.includes(u.role);
const OPEN = ['open', 'option_chosen', 'in_progress'];
const INTENTS = {
  buy_another: 'Buy another property', invest_auction: 'Invest in an auction or special-situation deal', downsize: 'Downsize and keep the remainder',
  direct_swap: 'Direct swap for an equivalent property', guidance: 'Not sure - I want guidance',
};
const OPTION_LABEL = {
  direct_swap: 'Direct exchange', trade_in: 'Trade-in for a new builder property', upgrade: 'Upgrade to a larger or better property',
  special_situation: 'Reinvest in a special-situation or auction property', downsize: 'Downsize and earn rental income', hold_and_rent: 'Hold and rent instead of selling',
};
const n = (v) => (v === null || v === undefined ? null : Number(v));
const enabled = async () => (await configService.getConfig('exchange.enabled', true)) !== false;

async function settings() {
  const [tolerance, holdDays, downsize, valuation, guidance] = await Promise.all([
    configService.getConfig('exchange.value_tolerance_percent', 25), configService.getConfig('exchange.hold_and_rent_after_days', 90), configService.getConfig('exchange.downsize_max_percent', 70),
    configService.getConfig('exchange.valuation_disclaimer', 'Indicative valuation. Verify independently before transacting.'),
    configService.getConfig('exchange.guidance_disclaimer', 'This is indicative guidance based on available platform data. It is not financial advice. Consult a qualified financial advisor and legal counsel before transacting.'),
  ]);
  return { tolerance: Number(tolerance) || 25, holdDays: Number(holdDays) || 90, downsize: Number(downsize) || 70, valuationDisclaimer: valuation, guidanceDisclaimer: guidance };
}

// ------------------------------------------------------------ valuation

// Indicative value of the old property: the platform's rate for the area x
// its size; failing that, the owner's own asking price.
async function valueProperty(p) {
  const est = await market.estimateValue(p).catch(() => null);
  if (est?.value) return { value: est.value, source: 'platform', basis: { perSqft: est.perSqft, areaSqft: n(p.area_sqft) || n(p.carpet_area_sqft), scope: est.scope, asOf: est.asOf || null } };
  if (p.price_value) return { value: Number(p.price_value), source: 'asking', basis: { note: 'Not enough platform data for this area - the asking price is used' } };
  return { value: null, source: null, basis: { note: 'No area rate or asking price available - a representative will value it' } };
}

// The least-loaded representative takes the request.
async function pickRep() {
  const r = await pool.query(
    `SELECT ar.user_id FROM arb_representatives ar JOIN users u ON u.id = ar.user_id AND u.status = 'active'
     WHERE ar.accepts_assignments ORDER BY (SELECT COUNT(*) FROM exchange_requests e WHERE e.assigned_rep_id = ar.user_id AND e.status = ANY($1::text[])) ASC, ar.created_at ASC LIMIT 1`,
    [OPEN]
  );
  return r.rows[0]?.user_id || null;
}

// ------------------------------------------------------------ requests

const REQUEST_SELECT = `
  SELECT e.*, p.title AS old_title, p.city AS old_city, p.locality AS old_locality, p.property_type::text AS old_type, p.bedrooms AS old_bedrooms, p.area_sqft AS old_area, p.price_value AS old_asking,
         p.status::text AS old_status, p.transaction_type::text AS old_transaction, p.created_at AS old_listed_at, p.estimated_rent_monthly AS old_rent,
         u.full_name AS owner_name, rep.full_name AS rep_name, ar.platform_number AS rep_number,
         t.title AS target_title, t.city AS target_city, t.locality AS target_locality
  FROM exchange_requests e JOIN properties p ON p.id = e.old_property_id JOIN users u ON u.id = e.owner_user_id
  LEFT JOIN users rep ON rep.id = e.assigned_rep_id LEFT JOIN arb_representatives ar ON ar.user_id = e.assigned_rep_id LEFT JOIN properties t ON t.id = e.new_target_reference`;

function shape(e, user) {
  const staff = isStaff(user);
  return {
    id: e.id, requestNumber: e.request_number, status: e.status, statusNote: e.status_note, exchangeType: e.exchange_type, reinvestmentIntent: e.reinvestment_intent, reinvestmentIntentLabel: INTENTS[e.reinvestment_intent],
    oldProperty: { id: e.old_property_id, title: e.old_title, city: e.old_city, locality: e.old_locality, propertyType: e.old_type, bedrooms: e.old_bedrooms, areaSqft: n(e.old_area), askingPrice: n(e.old_asking), listingStatus: e.old_status },
    wanted: { city: e.wanted_city, localities: e.wanted_localities, propertyType: e.wanted_property_type, bedroomsMin: e.wanted_bedrooms_min, budgetMax: n(e.wanted_budget_max) },
    notes: e.notes, oldPropertyValuation: n(e.old_property_valuation), valuationSource: e.valuation_source, valuationBasis: e.valuation_basis, valuedAt: e.valued_at,
    newTargetReference: e.new_target_reference, target: e.new_target_reference ? { id: e.new_target_reference, title: e.target_title, city: e.target_city, locality: e.target_locality } : null,
    targetValue: n(e.target_value), valueDifference: n(e.value_difference),
    // The owner sees who their representative is; staff also see who the owner is.
    representative: e.assigned_rep_id ? { name: e.rep_name, platformNumber: e.rep_number || null } : null,
    owner: staff ? { id: e.owner_user_id, name: e.owner_name } : undefined, counterpartyRequestId: staff ? e.counterparty_request_id : undefined,
    createdAt: e.created_at, updatedAt: e.updated_at,
  };
}

async function load(id) {
  const e = (await pool.query(`${REQUEST_SELECT} WHERE e.id = $1`, [id])).rows[0];
  if (!e) throw notFound('Exchange request not found');
  return e;
}

function assertAccess(user, e) {
  if (!isStaff(user) && e.owner_user_id !== user.id) throw forbidden('Not your exchange request');
}

// Listings of mine that can be put up for exchange.
async function myListings(user) {
  const r = await pool.query(
    `SELECT p.id, p.title, p.city, p.locality, p.property_type::text AS property_type, p.price_value, p.status::text AS status, p.created_at,
            EXISTS (SELECT 1 FROM exchange_requests e WHERE e.old_property_id = p.id AND e.status = ANY($2::text[])) AS in_exchange
     FROM properties p WHERE p.created_by = $1 AND p.status IN ('approved', 'pending_approval') AND p.listing_category::text <> 'institutional' ORDER BY p.created_at DESC LIMIT 100`,
    [user.id, OPEN]
  );
  return r.rows.map((p) => ({ id: p.id, title: p.title, city: p.city, locality: p.locality, propertyType: p.property_type, askingPrice: n(p.price_value), status: p.status, inExchange: p.in_exchange }));
}

async function create(user, data, meta = {}) {
  if (!(await enabled())) throw badRequest('Property exchange is switched off at the moment');
  if (isStaff(user)) throw badRequest('An exchange request is raised by the owner');
  const p = (await pool.query(`SELECT * FROM properties WHERE id = $1`, [data.oldPropertyId])).rows[0];
  if (!p) throw notFound('Listing not found');
  if (p.created_by !== user.id && p.broker_id !== user.id) throw forbidden('You can only exchange a property you listed');
  if (!['approved', 'pending_approval'].includes(p.status)) throw badRequest('List the property first - it must be live or awaiting approval');
  if (String(p.listing_category) === 'institutional') throw badRequest('Institutional assets are handled by the institutional desk');
  if (!INTENTS[data.reinvestmentIntent || 'guidance']) throw badRequest('Choose what you want to do');
  if ((await pool.query(`SELECT 1 FROM exchange_requests WHERE old_property_id = $1 AND status = ANY($2::text[])`, [p.id, OPEN])).rows.length) throw badRequest('This property already has an exchange request');
  const localities = [...new Set((Array.isArray(data.wantedLocalities) ? data.wantedLocalities : String(data.wantedLocalities || '').split(',')).map((x) => String(x).trim()).filter(Boolean))].slice(0, 10);
  const v = await valueProperty(p);
  const customer = (await pool.query('SELECT id FROM customers WHERE user_id = $1 ORDER BY created_at LIMIT 1', [user.id])).rows[0];
  const num = (await pool.query(`SELECT nextval('exchange_request_seq') AS n`)).rows[0].n;
  const rep = await pickRep();
  const e = (await pool.query(
    `INSERT INTO exchange_requests (request_number, owner_user_id, customer_id, old_property_id, reinvestment_intent, wanted_city, wanted_localities, wanted_property_type, wanted_bedrooms_min, wanted_budget_max, notes,
       old_property_valuation, valuation_source, valuation_basis, valued_at, assigned_rep_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CASE WHEN $12::numeric IS NULL THEN NULL ELSE now() END, $15) RETURNING id`,
    [`EX-${String(num).padStart(5, '0')}`, user.id, customer?.id || null, p.id, data.reinvestmentIntent || 'guidance', data.wantedCity ? String(data.wantedCity).trim().slice(0, 120) : p.city, JSON.stringify(localities),
      data.wantedPropertyType ? String(data.wantedPropertyType).slice(0, 40) : null, data.wantedBedroomsMin ? Number(data.wantedBedroomsMin) : null, data.wantedBudgetMax ? Number(data.wantedBudgetMax) : null,
      data.notes ? String(data.notes).slice(0, 2000) : null, v.value, v.source, JSON.stringify(v.basis), rep]
  )).rows[0];
  await pool.query('UPDATE properties SET exchange_intent = true WHERE id = $1', [p.id]);
  await auditService.log({ actor: user, action: 'exchange.requested', entityType: 'exchange_request', entityId: e.id, after: { propertyId: p.id, intent: data.reinvestmentIntent || 'guidance' }, ...meta });
  if (rep) await notificationService.createNotification({ userId: rep, type: 'exchange', title: 'New property exchange request', message: `${p.title} - ${INTENTS[data.reinvestmentIntent || 'guidance']}`, relatedEntityType: 'exchange_request', relatedEntityId: e.id }).catch(() => {});
  return detail(user, e.id);
}

async function list(user, { status } = {}) {
  const staff = isStaff(user);
  const where = [];
  const params = [];
  if (!staff) { params.push(user.id); where.push(`e.owner_user_id = $${params.length}`); }
  if (status === 'active') where.push(`e.status IN ('open', 'option_chosen', 'in_progress')`);
  else if (status) { params.push(status); where.push(`e.status = $${params.length}`); }
  const r = await pool.query(`${REQUEST_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY (e.status = 'option_chosen') DESC, e.created_at DESC LIMIT 300`, params);
  const interests = r.rows.length ? (await pool.query(`SELECT request_id, COUNT(*) FILTER (WHERE status = 'interested')::int AS waiting FROM exchange_interests WHERE request_id = ANY($1::uuid[]) GROUP BY 1`, [r.rows.map((x) => x.id)])).rows : [];
  return r.rows.map((e) => ({ ...shape(e, user), interestsWaiting: interests.find((i) => i.request_id === e.id)?.waiting || 0 }));
}

// ------------------------------------------------------------ options

const CARD = `p.id, p.title, p.city, p.locality, p.property_type::text AS property_type, p.bedrooms, p.area_sqft, p.price_value, p.listing_category::text AS category, p.is_verified, p.yield_percent, p.estimated_rent_monthly,
  (SELECT pm.url FROM property_media pm WHERE pm.property_id = p.id ORDER BY pm.is_primary DESC, pm.display_order ASC LIMIT 1) AS image`;

async function card(p, value) {
  return {
    propertyId: p.id, title: p.title, city: p.city, locality: p.locality, propertyType: p.property_type, bedrooms: p.bedrooms, areaSqft: n(p.area_sqft), value: n(value ?? p.price_value), verified: !!p.is_verified,
    image: p.image ? await getReadUrl(p.image).catch(() => null) : null,
  };
}

// Listings that fit what the owner wants. `extra` narrows it further.
async function fitting(e, extra, params = [], limit = 6) {
  const p = [e.old_property_id, e.owner_user_id, e.wanted_city || e.old_city, e.wanted_property_type, e.wanted_bedrooms_min, e.wanted_budget_max, ...params];
  const r = await pool.query(
    `SELECT ${CARD} FROM properties p
     WHERE p.status = 'approved' AND p.id <> $1 AND p.created_by <> $2 AND p.transaction_type::text = 'sell' AND p.price_value IS NOT NULL
       AND lower(p.city) = lower($3) AND ($4::varchar IS NULL OR p.property_type::text = $4) AND ($5::int IS NULL OR p.bedrooms >= $5) AND ($6::numeric IS NULL OR p.price_value <= $6)
       AND ${extra}
     ORDER BY p.is_verified DESC, p.created_at DESC LIMIT ${limit}`,
    p
  );
  return r.rows;
}

// Every path open to this owner, each with its value gap (+ = they pay more, - = they keep a surplus).
async function options(user, id) {
  const e = await load(id);
  assertAccess(user, e);
  const s = await settings();
  const old = n(e.old_property_valuation);
  const gap = (value) => (old === null || value === null || value === undefined ? null : Math.round(Number(value) - old));
  const out = [];

  // Model A - direct swap: their property fits what I want AND mine fits what they want, values within tolerance.
  const swaps = (await pool.query(
    `SELECT o.id AS request_id, o.old_property_valuation, ${CARD}
     FROM exchange_requests o JOIN properties p ON p.id = o.old_property_id JOIN properties mine ON mine.id = $1
     WHERE o.status = 'open' AND o.id <> $2 AND o.owner_user_id <> $3 AND p.status = 'approved'
       AND lower(p.city) = lower($4) AND ($5::varchar IS NULL OR p.property_type::text = $5) AND ($6::int IS NULL OR p.bedrooms >= $6)
       AND lower(mine.city) = lower(COALESCE(o.wanted_city, p.city)) AND (o.wanted_property_type IS NULL OR mine.property_type::text = o.wanted_property_type) AND (o.wanted_bedrooms_min IS NULL OR mine.bedrooms >= o.wanted_bedrooms_min)
       AND ($7::numeric IS NULL OR o.old_property_valuation IS NULL OR abs(o.old_property_valuation - $7::numeric) <= GREATEST(o.old_property_valuation, $7::numeric) * $8::numeric / 100.0)
     ORDER BY abs(COALESCE(o.old_property_valuation, 0) - COALESCE($7::numeric, 0)) ASC LIMIT 6`,
    [e.old_property_id, e.id, e.owner_user_id, e.wanted_city || e.old_city, e.wanted_property_type, e.wanted_bedrooms_min, old, s.tolerance]
  )).rows;
  if (swaps.length) {
    out.push({
      kind: 'direct_swap', label: OPTION_LABEL.direct_swap, model: 'A', description: 'Another owner has a property you want and wants one like yours. Swap directly; the value difference is settled between you off-platform.',
      items: await Promise.all(swaps.map(async (x) => ({ ...(await card(x, x.old_property_valuation ?? x.price_value)), counterpartyRequestId: x.request_id, valueDifference: gap(x.old_property_valuation ?? x.price_value) }))),
    });
  }

  // Model B - trade-in against builder / new stock.
  const builder = await fitting(e, `(p.builder_id IS NOT NULL OR EXISTS (SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = p.created_by AND r.name = 'builder'))`);
  if (builder.length) {
    out.push({
      kind: 'trade_in', label: OPTION_LABEL.trade_in, model: 'B', description: 'Give your old or stuck-up property as part-payment toward a new builder unit. You pay the difference.',
      items: await Promise.all(builder.map(async (x) => ({ ...(await card(x)), valueDifference: gap(x.price_value) }))),
    });
  }

  const intent = e.reinvestment_intent;
  // Upgrade: sell and move up to something larger or better - two linked deals.
  if (['buy_another', 'guidance'].includes(intent) && old !== null) {
    const up = await fitting(e, `p.price_value > $7::numeric AND p.builder_id IS NULL AND p.listing_category::text = 'residential' AND NOT EXISTS (SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = p.created_by AND r.name = 'builder')`, [old]);
    if (up.length) out.push({ kind: 'upgrade', label: OPTION_LABEL.upgrade, description: 'Your old property is sold and the proceeds go toward a larger or better-located one. Two linked deals.', items: await Promise.all(up.map(async (x) => ({ ...(await card(x)), valueDifference: gap(x.price_value) }))) });
  }
  // Reinvest in special-situation / auction inventory (Engine 4).
  if (['invest_auction', 'guidance'].includes(intent)) {
    const ss = (await pool.query(
      `SELECT ${CARD}, p.discount_percent FROM properties p WHERE p.status = 'approved' AND p.listing_category::text IN ('special_situation', 'auction') AND p.price_value IS NOT NULL
         AND ($1::numeric IS NULL OR p.price_value <= $1 * 1.1) ORDER BY (lower(p.city) = lower($2)) DESC, p.investment_score DESC NULLS LAST LIMIT 6`,
      [old, e.wanted_city || e.old_city]
    )).rows;
    if (ss.length) out.push({ kind: 'special_situation', label: OPTION_LABEL.special_situation, description: 'Sell your old property and reinvest the proceeds in a bank-auction or special-situation property priced below market.', items: await Promise.all(ss.map(async (x) => ({ ...(await card(x)), valueDifference: gap(x.price_value), discountPercent: n(x.discount_percent) }))) });
  }
  // Downsize and keep the remainder, with the indicative rental yield of the smaller property.
  if (['downsize', 'guidance'].includes(intent) && old !== null) {
    const small = await fitting({ ...e, wanted_budget_max: null, wanted_bedrooms_min: null }, `p.price_value <= $7::numeric * $8::numeric / 100.0 AND p.listing_category::text = 'residential'`, [old, s.downsize]);
    if (small.length) {
      out.push({
        kind: 'downsize', label: OPTION_LABEL.downsize, description: 'Sell, buy a smaller but better-located property and keep the remaining funds.',
        items: await Promise.all(small.map(async (x) => {
          const rentYield = x.yield_percent ? n(x.yield_percent) : x.estimated_rent_monthly && x.price_value ? Math.round(((Number(x.estimated_rent_monthly) * 12) / Number(x.price_value)) * 1000) / 10 : null;
          return { ...(await card(x)), valueDifference: gap(x.price_value), indicativeRentalYieldPercent: rentYield };
        })),
      });
    }
  }
  // Hold and rent: a sale listing that has sat for a long time without a deal.
  const listedDays = Math.floor((Date.now() - new Date(e.old_listed_at).getTime()) / 86400000);
  const hasDeal = (await pool.query(`SELECT 1 FROM deals WHERE property_id = $1 AND stage NOT IN ('closed_lost') LIMIT 1`, [e.old_property_id])).rows.length > 0;
  if (e.old_transaction === 'sell' && listedDays >= s.holdDays && !hasDeal) {
    const rent = n(e.old_rent) || (old ? Math.round((old * 0.03) / 12 / 100) * 100 : null);
    out.push({ kind: 'hold_and_rent', label: OPTION_LABEL.hold_and_rent, description: `Listed for sale for ${listedDays} days without a deal. Renting it out earns income while you wait for a better market.`, items: [], indicativeMonthlyRent: rent, rentBasis: e.old_rent ? 'From the listing' : 'About 3% a year of the indicative value' });
  }
  const mine = (await pool.query(`SELECT id, option_kind, target_property_id, counterparty_request_id, status, target_value, value_difference, note, created_at FROM exchange_interests WHERE request_id = $1 ORDER BY created_at DESC`, [id])).rows;
  for (const o of out) for (const it of o.items) it.interest = mine.find((m) => m.option_kind === o.kind && m.target_property_id === it.propertyId && m.status !== 'withdrawn')?.status || null;
  return { options: out, interests: mine.map((m) => ({ id: m.id, optionKind: m.option_kind, optionLabel: OPTION_LABEL[m.option_kind], targetPropertyId: m.target_property_id, status: m.status, targetValue: n(m.target_value), valueDifference: n(m.value_difference), note: m.note, createdAt: m.created_at })) };
}

// The Reinvestment Guidance panel.
async function detail(user, id) {
  const e = await load(id);
  assertAccess(user, e);
  const s = await settings();
  const opts = await options(user, id);
  const old = n(e.old_property_valuation);
  // What the kind of property they want typically costs in the area they want.
  const typical = (await pool.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price_value)::numeric AS median, COUNT(*)::int AS listings FROM properties
     WHERE status = 'approved' AND transaction_type::text = 'sell' AND price_value IS NOT NULL AND lower(city) = lower($1) AND ($2::varchar IS NULL OR property_type::text = $2) AND ($3::int IS NULL OR bedrooms >= $3)`,
    [e.wanted_city || e.old_city, e.wanted_property_type, e.wanted_bedrooms_min]
  )).rows[0];
  const targetTypical = typical.listings >= 3 ? Math.round(Number(typical.median)) : null;
  const legs = (await pool.query(`SELECT d.id, d.stage::text AS stage, d.deal_value, d.property_id, p.title, d.linked_deal_id FROM deals d LEFT JOIN properties p ON p.id = d.property_id WHERE d.exchange_request_id = $1 ORDER BY d.created_at`, [id])).rows;
  // Which options to put first for this person's stated intent.
  const order = { direct_swap: ['direct_swap', 'trade_in'], buy_another: ['direct_swap', 'trade_in', 'upgrade'], invest_auction: ['special_situation', 'direct_swap'], downsize: ['downsize', 'direct_swap'], guidance: ['direct_swap', 'trade_in', 'upgrade', 'special_situation', 'downsize'] }[e.reinvestment_intent];
  return {
    ...shape(e, user),
    guidance: {
      oldPropertyValuation: old, valuationDisclaimer: s.valuationDisclaimer,
      targetTypicalValue: targetTypical, targetBasis: targetTypical ? `Median of ${typical.listings} live listings matching what you want` : 'Not enough live listings to estimate',
      estimatedGap: old !== null && targetTypical !== null ? targetTypical - old : null,
      recommended: [...order.filter((k) => opts.options.some((o) => o.kind === k)), ...opts.options.map((o) => o.kind).filter((k) => !order.includes(k))],
      disclaimer: s.guidanceDisclaimer,
    },
    options: opts.options, interests: opts.interests,
    legs: legs.map((l) => ({ dealId: l.id, stage: l.stage, dealValue: n(l.deal_value), property: l.title, linkedDealId: l.linked_deal_id })),
    feeNote: 'Professional fee: 1% + GST on the gross value of each leg, each leg invoiced separately - 50% at the Agreement to Sell and 50% at the Sale Deed.',
  };
}

// ------------------------------------------------------------ owner actions

async function expressInterest(user, id, { optionKind, propertyId, note }, meta = {}) {
  const e = await load(id);
  if (e.owner_user_id !== user.id) throw forbidden('Not your exchange request');
  if (e.status !== 'open') throw badRequest('An option is already being worked on for this request');
  if (!OPTION_LABEL[optionKind]) throw badRequest('Unknown option');
  let item = null;
  if (optionKind !== 'hold_and_rent') {
    const opts = await options(user, id);
    item = opts.options.find((o) => o.kind === optionKind)?.items.find((i) => i.propertyId === propertyId);
    if (!item) throw badRequest('That option is no longer available');
    if ((await pool.query(`SELECT 1 FROM exchange_interests WHERE request_id = $1 AND option_kind = $2 AND target_property_id = $3 AND status = 'interested'`, [id, optionKind, propertyId])).rows.length) throw badRequest('You have already marked this one');
  }
  const r = (await pool.query(
    `INSERT INTO exchange_interests (request_id, option_kind, target_property_id, counterparty_request_id, target_value, value_difference, note) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [id, optionKind, item?.propertyId || null, item?.counterpartyRequestId || null, item?.value ?? null, item?.valueDifference ?? null, note ? String(note).slice(0, 500) : null]
  )).rows[0];
  await auditService.log({ actor: user, action: 'exchange.interest', entityType: 'exchange_request', entityId: id, after: { optionKind, propertyId }, ...meta });
  if (e.assigned_rep_id) await notificationService.createNotification({ userId: e.assigned_rep_id, type: 'exchange', title: `Exchange ${e.request_number}: owner wants ${OPTION_LABEL[optionKind].toLowerCase()}`, message: item ? `${item.title} (${[item.locality, item.city].filter(Boolean).join(', ')})` : e.old_title, relatedEntityType: 'exchange_request', relatedEntityId: id }).catch(() => {});
  return { id: r.id, message: 'Your A R Buildwel representative will take this forward and contact you.' };
}

async function cancel(user, id, { reason } = {}, meta = {}) {
  const e = await load(id);
  assertAccess(user, e);
  if (!['open', 'option_chosen'].includes(e.status)) throw badRequest(e.status === 'in_progress' ? 'Deals are already open on this exchange - ask your representative' : 'This request is already closed');
  await pool.query(`UPDATE exchange_requests SET status = 'cancelled', status_note = $1, updated_at = now() WHERE id = $2`, [reason ? String(reason).slice(0, 500) : null, id]);
  await pool.query(`UPDATE exchange_interests SET status = 'withdrawn' WHERE request_id = $1 AND status = 'interested'`, [id]);
  await pool.query('UPDATE properties SET exchange_intent = false WHERE id = $1', [e.old_property_id]);
  await auditService.log({ actor: user, action: 'exchange.cancelled', entityType: 'exchange_request', entityId: id, after: { reason }, ...meta });
  return detail(user, id);
}

// ------------------------------------------------------------ staff actions

async function setValuation(staff, id, { value, note }, meta = {}) {
  if (!isStaff(staff)) throw forbidden('A R Buildwel staff value the property');
  const v = Number(value);
  if (!(v > 0)) throw badRequest('Give the indicative value in rupees');
  if (!note || String(note).trim().length < 5) throw badRequest('Say what the value is based on');
  const e = await load(id);
  if (!OPEN.includes(e.status)) throw badRequest('This request is closed');
  await pool.query(`UPDATE exchange_requests SET old_property_valuation = $1, valuation_source = 'admin', valuation_basis = $2, valued_by = $3, valued_at = now(), updated_at = now() WHERE id = $4`, [v, JSON.stringify({ note: String(note).trim().slice(0, 500), previous: n(e.old_property_valuation) }), staff.id, id]);
  await auditService.log({ actor: staff, action: 'exchange.valued', entityType: 'exchange_request', entityId: id, after: { value: v, note }, ...meta });
  await notificationService.createNotification({ userId: e.owner_user_id, type: 'exchange', title: `Exchange ${e.request_number}: valuation updated`, message: 'Your representative has reviewed the indicative value of your property.', relatedEntityType: 'exchange_request', relatedEntityId: id }).catch(() => {});
  return detail(staff, id);
}

async function customerFor(client, userId) {
  const c = (await client.query('SELECT id FROM customers WHERE user_id = $1 ORDER BY created_at LIMIT 1', [userId])).rows[0];
  if (c) return c.id;
  const u = (await client.query('SELECT full_name, email, mobile FROM users WHERE id = $1', [userId])).rows[0];
  return (await client.query('INSERT INTO customers (user_id, full_name, email, mobile) VALUES ($1, $2, $3, $4) RETURNING id', [userId, u.full_name, u.email, u.mobile])).rows[0].id;
}

// The representative confirms the option the owner chose: this opens the deals.
//   direct swap / trade-in  two legs linked to each other
//   upgrade / special situation / downsize  the purchase leg now; the sale
//                           of the old property is its own deal when a
//                           buyer is found (linked then)
async function confirmInterest(staff, interestId, meta = {}) {
  if (!isStaff(staff)) throw forbidden('A R Buildwel staff confirm the option');
  const i = (await pool.query('SELECT * FROM exchange_interests WHERE id = $1', [interestId])).rows[0];
  if (!i) throw notFound('Interest not found');
  if (i.status !== 'interested') throw badRequest('This has already been decided');
  if (i.option_kind === 'hold_and_rent') throw badRequest('Hold and rent needs no deal - help the owner list the property for rent');
  const e = await load(i.request_id);
  if (e.status !== 'open') throw badRequest('This request already has an option in progress');
  const target = (await pool.query(`SELECT id, status::text AS status, created_by, broker_id, builder_id, price_value, tenant_id FROM properties WHERE id = $1`, [i.target_property_id])).rows[0];
  if (!target || target.status !== 'approved') throw badRequest('The other property is no longer live');
  const rep = e.assigned_rep_id || staff.id;
  const linked = ['direct_swap', 'trade_in'].includes(i.option_kind);
  let other = null;
  if (i.option_kind === 'direct_swap') {
    other = (await pool.query('SELECT * FROM exchange_requests WHERE id = $1', [i.counterparty_request_id])).rows[0];
    if (!other || other.status !== 'open') throw badRequest('The other owner\'s exchange request is no longer open');
  }
  const oldValue = n(e.old_property_valuation) ?? n(e.old_asking);
  const targetValue = n(i.target_value) ?? n(target.price_value);
  if (linked && !oldValue) throw badRequest('Value the old property first');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const leg = async (customerId, propertyId, value) => (await client.query(
      `INSERT INTO deals (customer_id, property_id, broker_id, stage, deal_value, assigned_rep_id, exchange_request_id) VALUES ($1, $2, $3, 'negotiation', $4, $3, $5) RETURNING id`,
      [customerId, propertyId, rep, value, e.id]
    )).rows[0].id;
    // Leg 1: the owner acquires the target property.
    const ownerCustomer = e.customer_id || (await customerFor(client, e.owner_user_id));
    const leg1 = await leg(ownerCustomer, target.id, targetValue);
    let leg2 = null;
    if (linked) {
      // Leg 2: the other side acquires the owner's old property.
      const otherUser = i.option_kind === 'direct_swap' ? other.owner_user_id : target.builder_id || target.created_by;
      leg2 = await leg(await customerFor(client, otherUser), e.old_property_id, oldValue);
      await client.query('UPDATE deals SET linked_deal_id = $1 WHERE id = $2', [leg2, leg1]);
      await client.query('UPDATE deals SET linked_deal_id = $1 WHERE id = $2', [leg1, leg2]);
    }
    const difference = oldValue !== null && targetValue !== null ? targetValue - oldValue : null;
    await client.query(
      `UPDATE exchange_requests SET status = 'in_progress', exchange_type = $1, new_target_reference = $2, counterparty_request_id = $3, target_value = $4, value_difference = $5, customer_id = $6, updated_at = now() WHERE id = $7`,
      [linked ? i.option_kind : null, target.id, other?.id || null, targetValue, difference, ownerCustomer, e.id]
    );
    if (other) {
      await client.query(
        `UPDATE exchange_requests SET status = 'in_progress', exchange_type = 'direct_swap', new_target_reference = $1, counterparty_request_id = $2, target_value = $3, value_difference = $4, updated_at = now() WHERE id = $5`,
        [e.old_property_id, e.id, oldValue, difference === null ? null : -difference, other.id]
      );
      await client.query(`UPDATE exchange_interests SET status = 'withdrawn' WHERE request_id = $1 AND status = 'interested'`, [other.id]);
    }
    await client.query(`UPDATE exchange_interests SET status = 'confirmed', decided_by = $1, decided_at = now() WHERE id = $2`, [staff.id, i.id]);
    await client.query(`UPDATE exchange_interests SET status = 'withdrawn' WHERE request_id = $1 AND id <> $2 AND status = 'interested'`, [e.id, i.id]);
    await client.query('COMMIT');
    await auditService.log({ actor: staff, action: 'exchange.confirmed', entityType: 'exchange_request', entityId: e.id, after: { option: i.option_kind, legs: [leg1, leg2].filter(Boolean), difference }, ...meta });
    const told = [e.owner_user_id, other?.owner_user_id].filter(Boolean);
    for (const u of told) {
      await notificationService.createNotification({ userId: u, type: 'exchange', title: `${OPTION_LABEL[i.option_kind]} is going ahead`, message: 'Your A R Buildwel representative has opened the deal and will coordinate every step. Any value difference is settled between the parties off-platform.', relatedEntityType: 'exchange_request', relatedEntityId: u === e.owner_user_id ? e.id : other.id }).catch(() => {});
    }
    return detail(staff, e.id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function declineInterest(staff, interestId, { note }, meta = {}) {
  if (!isStaff(staff)) throw forbidden('A R Buildwel staff decide this');
  if (!note || String(note).trim().length < 5) throw badRequest('Give the owner the reason');
  const i = (await pool.query(`UPDATE exchange_interests SET status = 'declined', note = $1, decided_by = $2, decided_at = now() WHERE id = $3 AND status = 'interested' RETURNING *`, [String(note).trim().slice(0, 500), staff.id, interestId])).rows[0];
  if (!i) throw badRequest('This has already been decided');
  const e = await load(i.request_id);
  await auditService.log({ actor: staff, action: 'exchange.interest_declined', entityType: 'exchange_request', entityId: e.id, after: { note }, ...meta });
  await notificationService.createNotification({ userId: e.owner_user_id, type: 'exchange', title: `Exchange ${e.request_number}: option not available`, message: String(note).trim().slice(0, 200), relatedEntityType: 'exchange_request', relatedEntityId: e.id }).catch(() => {});
  return detail(staff, e.id);
}

// Linked closure: both legs close in one step, each having met its own
// closing requirements (fee instalments paid and so on).
async function closeLinked(staff, id, meta = {}) {
  if (!isStaff(staff)) throw forbidden('A R Buildwel staff close an exchange');
  const e = await load(id);
  if (e.status !== 'in_progress') throw badRequest('This exchange has no deals in progress');
  const legs = (await pool.query(`SELECT id, stage::text AS stage, linked_deal_id FROM deals WHERE exchange_request_id = $1 OR exchange_request_id = $2 ORDER BY created_at`, [id, e.counterparty_request_id])).rows.filter((d) => d.stage !== 'closed_lost');
  if (!legs.length) throw badRequest('No deals found for this exchange');
  const open = legs.filter((d) => d.stage !== 'closed_won');
  const orchestration = require('./orchestration.service');
  const dealService = require('./deal.service');
  // Check every leg first so one cannot close without the other.
  if (open.some((d) => d.stage !== 'payment')) throw badRequest('Both legs must reach Payment Confirmation before the exchange can close');
  for (const d of open) await orchestration.assertCanEnter(d.id, 'closed_won', staff, {});
  for (const d of open) await dealService.changeStage(d.id, 'closed_won', staff, `Linked closure of exchange ${e.request_number}`, { orchestrated: true, linkedClose: true });
  const ids = [id, e.counterparty_request_id].filter(Boolean);
  await pool.query(`UPDATE exchange_requests SET status = 'closed', updated_at = now() WHERE id = ANY($1::uuid[])`, [ids]);
  await pool.query(`UPDATE properties SET exchange_intent = false WHERE id IN (SELECT old_property_id FROM exchange_requests WHERE id = ANY($1::uuid[]))`, [ids]);
  await auditService.log({ actor: staff, action: 'exchange.closed', entityType: 'exchange_request', entityId: id, after: { legs: legs.map((l) => l.id) }, ...meta });
  return detail(staff, id);
}

async function summary() {
  const r = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open, COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress, COUNT(*) FILTER (WHERE status = 'closed')::int AS closed,
            COUNT(*) FILTER (WHERE status = 'open' AND old_property_valuation IS NULL)::int AS to_value,
            (SELECT COUNT(*)::int FROM exchange_interests WHERE status = 'interested') AS to_confirm FROM exchange_requests`
  )).rows[0];
  return r;
}

module.exports = { INTENTS, OPTION_LABEL, myListings, create, list, detail, options, expressInterest, cancel, setValuation, confirmInterest, declineInterest, closeLinked, summary };
