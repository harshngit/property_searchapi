const pool = require('../config/db');

function notFound(message = 'Not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

const TOP_N = 20;

// Scoring is the platform Matching Engine (sec. 7 binding weights:
// location 30, budget 25, type 20, area 15, amenities 10) applied to the
// customer's saved preferences - the same engine behind the website's
// requirement matches, so the CRM and the buyer see the same %.
const matchEngine = require('./matchEngine.service');

// Core matching run, shared by GET /properties/:customerId, POST /rerun,
// and GET /recommendations/:leadId. `leadId` is null for the plain
// customer-level view; passing it scopes the saved results to that lead
// (see migration 008 notes) so the two don't overwrite each other.
async function runMatchingForCustomer(customerId, leadId = null) {
  const customerResult = await pool.query('SELECT id, tenant_id FROM customers WHERE id = $1', [customerId]);
  if (customerResult.rows.length === 0) throw notFound('Customer not found');
  const customer = customerResult.rows[0];

  const preferencesResult = await pool.query(
    'SELECT * FROM customer_preferences WHERE customer_id = $1',
    [customerId]
  );
  const preferences = preferencesResult.rows[0] || {
    budget_min: null,
    budget_max: null,
    preferred_locations: [],
    property_type: null,
    transaction_type: null,
  };

  // Loose SQL prefilter (approved + tenant-scoped); exact scoring happens in
  // JS below since the weighting logic doesn't translate cleanly to SQL.
  // Properties with no tenant (e.g. legacy/global listings) are included
  // alongside the customer's own tenant - see README design notes.
  const where = [`status = 'approved'`];
  const params = [];
  if (customer.tenant_id) {
    params.push(customer.tenant_id);
    where.push(`(tenant_id = $${params.length} OR tenant_id IS NULL)`);
  }

  const propertiesResult = await pool.query(
    `SELECT * FROM properties WHERE ${where.join(' AND ')}`,
    params
  );

  const settings = await matchEngine.settings();
  const requirement = matchEngine.preferencesToRequirement(preferences, customerId);
  if (!requirement.city) requirement.city = '';
  const wantedTx = preferences.transaction_type === 'rent' ? ['rent'] : preferences.transaction_type ? ['sell', 'buy'] : null;
  const ranked = propertiesResult.rows
    .filter((property) => !wantedTx || wantedTx.includes(property.transaction_type))
    .map((property) => {
      const m = matchEngine.scoreOne(property, requirement, settings);
      // No preferred city: location is neutral rather than a zero.
      if (!requirement.city) {
        m.breakdown.location = { score: 100, weight: m.breakdown.location.weight, detail: 'No preferred location' };
        m.score = Math.round(Object.values(m.breakdown).reduce((sum, c) => sum + c.score * (c.weight / 100), 0));
        m.rankScore = m.score + Object.values(m.boosts).reduce((a, b) => a + b, 0);
      }
      return { property, score: m.score, rankScore: m.rankScore, tier: m.tier, reasons: { tier: m.tier, breakdown: m.breakdown } };
    })
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, TOP_N);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      leadId
        ? 'DELETE FROM property_match_results WHERE customer_id = $1 AND lead_id = $2'
        : 'DELETE FROM property_match_results WHERE customer_id = $1 AND lead_id IS NULL',
      leadId ? [customerId, leadId] : [customerId]
    );

    const saved = [];
    for (const entry of ranked) {
      const result = await client.query(
        `INSERT INTO property_match_results (lead_id, customer_id, property_id, relevance_score, matched_reasons)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [leadId, customerId, entry.property.id, entry.score, JSON.stringify(entry.reasons)]
      );
      saved.push({ ...result.rows[0], tier: entry.tier, property: entry.property });
    }

    await client.query('COMMIT');
    return saved;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// GET /api/matching/properties/:customerId
async function getMatchesForCustomer(customerId) {
  return runMatchingForCustomer(customerId, null);
}

// POST /api/matching/rerun
async function rerunForCustomer(customerId) {
  return runMatchingForCustomer(customerId, null);
}

// GET /api/matching/recommendations/:leadId
async function getRecommendationsForLead(leadId) {
  const leadResult = await pool.query('SELECT id, customer_id FROM leads WHERE id = $1', [leadId]);
  if (leadResult.rows.length === 0) throw notFound('Lead not found');
  return runMatchingForCustomer(leadResult.rows[0].customer_id, leadId);
}

module.exports = {
  getMatchesForCustomer,
  rerunForCustomer,
  getRecommendationsForLead,
};
