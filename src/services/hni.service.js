const pool = require('../config/db');
const configService = require('./config.service');
const disclaimerService = require('./disclaimer.service');
const investorService = require('./investor.service');
const opportunityService = require('./opportunity.service');
const liquidityService = require('./liquidity.service');
const { signUrls } = require('../utils/storage');
const { parsePagination, buildPagination } = require('../utils/pagination');
const { formatInr } = require('../utils/price');
const { badRequest, notFound } = require('../utils/httpError');

// Engine 3 - HNI Investment Module: curated deal flow (special situation,
// bank auctions, institutional, high-ticket commercial), portfolio
// dashboard with ROI / yield / Liquidity Score, exit tracking, and investor
// behaviour tracking. All projections are indicative and disclaimered.

const CURATED_CATEGORIES = ['special_situation', 'auction', 'institutional'];

// ---------------------------------------------------------------------
// Curated deals
// ---------------------------------------------------------------------
async function getCuratedDeals(user, query) {
  const profile = await investorService.resolveProfile(user, query.investorId).catch((err) => {
    if (investorService.isStaff(user) && !query.investorId) return null;
    throw err;
  });
  if (profile) investorService.assertHni(profile);
  const access = await opportunityService.getAccess(user);

  const { page, limit, offset } = parsePagination(query, 12);
  const where = [`p.status = 'approved'`];
  const highTicketMin = await configService.getConfig('hni.high_ticket_commercial_min', 10000000);
  const params = [CURATED_CATEGORIES, Number(highTicketMin)];
  where.push(`(p.listing_category::text = ANY($1::text[]) OR (p.property_type = 'commercial' AND p.price_value >= $2))`);

  if (query.listingCategory) {
    params.push(query.listingCategory);
    where.push(`p.listing_category = $${params.length}`);
  }
  if (query.city) {
    params.push(query.city);
    where.push(`p.city ILIKE $${params.length}`);
  }
  if (query.includePast !== 'true') {
    where.push(`(p.listing_category <> 'auction' OR p.auction_date IS NULL OR p.auction_date >= now() - interval '1 day')`);
  }

  // Profile match (on by default): preferred cities, asset classes and
  // ticket-size range. Empty preferences don't restrict.
  const matchProfile = profile && query.matchProfile !== 'false';
  if (matchProfile) {
    params.push(JSON.stringify(profile.preferred_cities || []));
    where.push(
      `($${params.length}::jsonb = '[]'::jsonb OR EXISTS (SELECT 1 FROM jsonb_array_elements_text($${params.length}::jsonb) c WHERE LOWER(c) = LOWER(p.city)))`
    );
    params.push(JSON.stringify(profile.asset_class_preferences || []));
    where.push(
      `($${params.length}::jsonb = '[]'::jsonb OR $${params.length}::jsonb ? p.listing_category::text OR ($${params.length}::jsonb ? 'commercial' AND p.property_type = 'commercial'))`
    );
    if (profile.ticket_size_min != null) {
      params.push(profile.ticket_size_min);
      where.push(`(COALESCE(p.reserve_price, p.price_value) IS NULL OR COALESCE(p.reserve_price, p.price_value) >= $${params.length})`);
    }
    if (profile.ticket_size_max != null) {
      params.push(profile.ticket_size_max);
      where.push(`(COALESCE(p.reserve_price, p.price_value) IS NULL OR COALESCE(p.reserve_price, p.price_value) <= $${params.length})`);
    }
  }

  const whereClause = `WHERE ${where.join(' AND ')}`;
  const count = await pool.query(`SELECT COUNT(*) FROM properties p ${whereClause}`, params);
  params.push(limit, offset);
  const fullColumns = access.full
    ? `, p.source_bank, p.auction_reference_id, p.emd_amount, p.estimated_market_value, p.liquidity_score, p.score_breakdown`
    : '';
  const result = await pool.query(
    `SELECT ${opportunityService.TEASER_COLUMNS}, p.annual_appreciation_percent ${fullColumns},
            (SELECT action FROM investor_deal_interactions i WHERE i.property_id = p.id AND i.user_id = $${params.length + 1}
             AND i.action IN ('shortlisted', 'unshortlisted') ORDER BY i.created_at DESC LIMIT 1) = 'shortlisted' AS is_shortlisted
     FROM properties p ${whereClause}
     ORDER BY p.investment_score DESC NULLS LAST, p.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    [...params, profile?.user_id || user.id]
  );

  const items = result.rows.map((row) => {
    const teaser = opportunityService.toTeaser(row);
    const ask = Number(row.reserve_price ?? row.price_value) || null;
    const indicativeYield = row.yield_percent != null
      ? Number(row.yield_percent)
      : row.estimated_rent_monthly && ask ? Math.round(((Number(row.estimated_rent_monthly) * 12) / ask) * 10000) / 100 : null;
    return {
      ...(access.full ? { ...row, source_label: teaser.source_label, locked: false } : teaser),
      title: teaser.title, // institutional names stay masked until NDA
      indicative_yield_percent: indicativeYield,
      is_shortlisted: !!row.is_shortlisted,
    };
  });

  return {
    items: await signUrls(items, 'primary_image'),
    pagination: buildPagination(page, limit, count.rows[0].count),
    matchedToProfile: !!matchProfile,
    access: { full: access.full, reason: access.full ? null : access.reason },
    disclaimers: await disclaimerService.getDisclaimers(['investment_guidance', 'special_situation', 'auction']),
  };
}

const TRACKABLE_ACTIONS = ['shortlisted', 'unshortlisted', 'dismissed', 'shared', 'document_requested'];

async function trackDeal(propertyId, action, user) {
  if (!TRACKABLE_ACTIONS.includes(action)) throw badRequest(`action must be one of: ${TRACKABLE_ACTIONS.join(', ')}`);
  const property = await pool.query(
    `SELECT id, listing_category, city, reserve_price, price_value FROM properties WHERE id = $1 AND status = 'approved'`,
    [propertyId]
  );
  if (!property.rows[0]) throw notFound('Deal not found');
  const profile = await investorService.getProfileByUserId(user.id);
  const p = property.rows[0];
  await pool.query(
    `INSERT INTO investor_deal_interactions (investor_profile_id, user_id, property_id, action, listing_category, city, ticket_size)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [profile?.id || null, user.id, propertyId, action, p.listing_category, p.city, p.reserve_price ?? p.price_value ?? null]
  );
  return { propertyId, action };
}

async function getShortlist(user) {
  const result = await pool.query(
    `SELECT ${opportunityService.TEASER_COLUMNS}, latest.created_at AS shortlisted_at
     FROM (
       SELECT DISTINCT ON (property_id) property_id, action, created_at FROM investor_deal_interactions
       WHERE user_id = $1 AND action IN ('shortlisted', 'unshortlisted')
       ORDER BY property_id, created_at DESC
     ) latest
     JOIN properties p ON p.id = latest.property_id
     WHERE latest.action = 'shortlisted' AND p.status = 'approved'
     ORDER BY latest.created_at DESC`,
    [user.id]
  );
  return signUrls(result.rows.map((r) => ({ ...opportunityService.toTeaser(r), shortlisted_at: r.shortlisted_at })), 'primary_image');
}

// ---------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------
const INVESTMENT_FIELDS = {
  propertyId: 'property_id',
  title: 'title',
  assetClass: 'asset_class',
  city: 'city',
  locality: 'locality',
  propertyType: 'property_type',
  acquisitionDate: 'acquisition_date',
  acquisitionCost: 'acquisition_cost',
  additionalCosts: 'additional_costs',
  currentValuation: 'current_valuation',
  valuationDate: 'valuation_date',
  monthlyRentalIncome: 'monthly_rental_income',
  annualExpenses: 'annual_expenses',
  status: 'status',
  targetExitDate: 'target_exit_date',
  targetExitValue: 'target_exit_value',
  exitDate: 'exit_date',
  exitValue: 'exit_value',
  notes: 'notes',
};

function round2(n) {
  return n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
}

// All metrics derive from stored inputs at read time - nothing computed is
// ever persisted, so a valuation update instantly flows through.
function computeMetrics(inv) {
  const totalCost = Number(inv.acquisition_cost) + Number(inv.additional_costs || 0);
  const exited = inv.status === 'exited' && inv.exit_value != null;
  const currentValue = exited ? Number(inv.exit_value) : inv.current_valuation != null ? Number(inv.current_valuation) : totalCost;
  const annualRent = Number(inv.monthly_rental_income || 0) * 12;
  const netAnnualIncome = annualRent - Number(inv.annual_expenses || 0);

  const endDate = exited && inv.exit_date ? new Date(inv.exit_date) : new Date();
  const years = inv.acquisition_date ? Math.max((endDate - new Date(inv.acquisition_date)) / (365.25 * 24 * 3600 * 1000), 0) : null;
  const capitalGain = currentValue - totalCost;
  const incomeToDate = years !== null ? netAnnualIncome * years : 0;

  return {
    total_cost: round2(totalCost),
    current_value: round2(currentValue),
    capital_gain: round2(capitalGain),
    gross_rental_yield_percent: totalCost > 0 ? round2((annualRent / totalCost) * 100) : null,
    net_rental_yield_percent: totalCost > 0 ? round2((netAnnualIncome / totalCost) * 100) : null,
    holding_years: round2(years),
    income_to_date: round2(incomeToDate),
    absolute_return_percent: totalCost > 0 ? round2(((capitalGain + incomeToDate) / totalCost) * 100) : null,
    capital_cagr_percent:
      totalCost > 0 && years !== null && years >= 0.25 ? round2((Math.pow(currentValue / totalCost, 1 / years) - 1) * 100) : null,
  };
}

async function withLiquidity(rows) {
  const cache = new Map();
  return Promise.all(
    rows.map(async (row) => {
      if (row.status === 'exited' || !row.city) return { ...row, liquidity: null };
      const key = `${row.city}|${row.locality || ''}|${row.property_type || ''}`.toLowerCase();
      if (!cache.has(key)) {
        cache.set(key, liquidityService.computeLiquidity({ city: row.city, locality: row.locality, propertyType: row.property_type }));
      }
      const liquidity = await cache.get(key);
      return { ...row, liquidity: { score: liquidity.score, band: liquidity.band, label: liquidity.label || null } };
    })
  );
}

async function getAccessibleInvestment(id, user) {
  const result = await pool.query('SELECT * FROM hni_investments WHERE id = $1', [id]);
  if (!result.rows[0]) throw notFound('Investment not found');
  const profile = await investorService.getProfileById(result.rows[0].investor_profile_id);
  investorService.assertProfileAccess(profile, user);
  return result.rows[0];
}

async function listPortfolio(user, query) {
  const profile = await investorService.resolveProfile(user, query.investorId);
  investorService.assertHni(profile);
  const params = [profile.id];
  let statusClause = '';
  if (query.status) {
    params.push(query.status);
    statusClause = `AND status = $2`;
  }
  const result = await pool.query(
    `SELECT * FROM hni_investments WHERE investor_profile_id = $1 ${statusClause} ORDER BY acquisition_date DESC NULLS LAST, created_at DESC`,
    params
  );
  const items = await withLiquidity(result.rows.map((r) => ({ ...r, metrics: computeMetrics(r) })));
  return { items, disclaimers: await disclaimerService.getDisclaimers(['investment_guidance', 'hni_portfolio']) };
}

async function getInvestment(id, user) {
  const row = await getAccessibleInvestment(id, user);
  const [withLiq] = await withLiquidity([{ ...row, metrics: computeMetrics(row) }]);
  return withLiq;
}

async function createInvestment(data, user) {
  const profile = await investorService.resolveProfile(user, data.investorId);
  investorService.assertHni(profile);
  const cols = ['investor_profile_id'];
  const values = [profile.id];
  for (const [key, col] of Object.entries(INVESTMENT_FIELDS)) {
    if (data[key] !== undefined) {
      cols.push(col);
      values.push(data[key]);
    }
  }
  const result = await pool.query(
    `INSERT INTO hni_investments (${cols.join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    values
  );
  return getInvestment(result.rows[0].id, user);
}

async function updateInvestment(id, data, user) {
  const existing = await getAccessibleInvestment(id, user);
  const next = { ...existing };
  const set = [];
  const params = [];
  for (const [key, col] of Object.entries(INVESTMENT_FIELDS)) {
    if (data[key] !== undefined) {
      params.push(data[key]);
      set.push(`${col} = $${params.length}`);
      next[col] = data[key];
    }
  }
  if (set.length === 0) throw badRequest('No updatable fields provided');
  if (next.status === 'exited' && (next.exit_value == null || !next.exit_date)) {
    throw badRequest('exitValue and exitDate are required to mark an investment exited');
  }
  params.push(id);
  await pool.query(`UPDATE hni_investments SET ${set.join(', ')} WHERE id = $${params.length}`, params);
  return getInvestment(id, user);
}

async function deleteInvestment(id, user) {
  await getAccessibleInvestment(id, user);
  await pool.query('DELETE FROM hni_investments WHERE id = $1', [id]);
}

async function getPortfolioSummary(user, investorId) {
  const { items, disclaimers } = await listPortfolio(user, { investorId });
  const active = items.filter((i) => i.status !== 'exited');
  const exited = items.filter((i) => i.status === 'exited');

  const sum = (list, pick) => list.reduce((acc, i) => acc + (Number(pick(i)) || 0), 0);
  const invested = sum(active, (i) => i.metrics.total_cost);
  const currentValue = sum(active, (i) => i.metrics.current_value);
  const annualRent = sum(active, (i) => Number(i.monthly_rental_income) * 12);
  const netIncome = sum(active, (i) => Number(i.monthly_rental_income) * 12 - Number(i.annual_expenses));

  const allocation = (keyFn) => {
    const map = new Map();
    for (const i of active) {
      const key = keyFn(i) || 'unspecified';
      map.set(key, (map.get(key) || 0) + i.metrics.current_value);
    }
    return [...map.entries()]
      .map(([key, value]) => ({ key, value: round2(value), percent: currentValue > 0 ? round2((value / currentValue) * 100) : 0 }))
      .sort((a, b) => b.value - a.value);
  };

  const liquidityMix = { high: 0, moderate: 0, low: 0, unknown: 0 };
  for (const i of active) liquidityMix[i.liquidity?.band || 'unknown'] += 1;

  return {
    positions: { active: active.length, exitPlanned: active.filter((i) => i.status === 'exit_planned').length, exited: exited.length },
    totals: {
      invested: round2(invested),
      investedDisplay: formatInr(invested),
      currentValue: round2(currentValue),
      currentValueDisplay: formatInr(currentValue),
      unrealisedGain: round2(currentValue - invested),
      unrealisedGainPercent: invested > 0 ? round2(((currentValue - invested) / invested) * 100) : null,
      annualRentalIncome: round2(annualRent),
      grossYieldPercent: invested > 0 ? round2((annualRent / invested) * 100) : null,
      netYieldPercent: invested > 0 ? round2((netIncome / invested) * 100) : null,
      realisedGain: round2(sum(exited, (i) => i.metrics.capital_gain)),
    },
    allocationByAssetClass: allocation((i) => i.asset_class),
    allocationByCity: allocation((i) => i.city),
    liquidityMix,
    exitPipeline: active
      .filter((i) => i.status === 'exit_planned' || i.target_exit_date)
      .map((i) => ({
        id: i.id,
        title: i.title,
        targetExitDate: i.target_exit_date,
        targetExitValue: i.target_exit_value,
        currentValue: i.metrics.current_value,
        liquidity: i.liquidity,
      }))
      .sort((a, b) => String(a.targetExitDate || '9999').localeCompare(String(b.targetExitDate || '9999'))),
    disclaimers,
  };
}

async function getDashboard(user, investorId) {
  const profile = await investorService.resolveProfile(user, investorId);
  investorService.assertHni(profile);
  const [summary, deals, interests, shortlist] = await Promise.all([
    getPortfolioSummary(user, profile.id),
    getCuratedDeals(user, { investorId: profile.id, limit: 6 }),
    pool.query(
      `SELECT oi.id, oi.stage, oi.updated_at, p.title, p.listing_category, p.city
       FROM opportunity_interests oi JOIN properties p ON p.id = oi.property_id
       WHERE oi.user_id = $1 ORDER BY oi.updated_at DESC LIMIT 10`,
      [profile.user_id]
    ),
    getShortlist({ id: profile.user_id }),
  ]);
  return {
    profile: {
      id: profile.id,
      fullName: profile.full_name,
      investorCategory: profile.investor_category,
      verificationStatus: profile.verification_status,
      ticketSizeMin: profile.ticket_size_min,
      ticketSizeMax: profile.ticket_size_max,
    },
    assignedManager: profile.assigned_manager_id
      ? { id: profile.assigned_manager_id, name: profile.manager_name, email: profile.manager_email, mobile: profile.manager_mobile }
      : null,
    portfolio: summary,
    curatedDeals: deals.items,
    dealAccess: deals.access,
    activeInterests: interests.rows,
    shortlistCount: shortlist.length,
    disclaimers: summary.disclaimers,
  };
}

module.exports = {
  getCuratedDeals,
  trackDeal,
  getShortlist,
  listPortfolio,
  getInvestment,
  createInvestment,
  updateInvestment,
  deleteInvestment,
  getPortfolioSummary,
  getDashboard,
  computeMetrics,
};
