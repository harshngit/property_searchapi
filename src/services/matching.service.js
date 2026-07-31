const pool = require('../config/db');

function notFound(message = 'Not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

const TOP_N = 20;

// Weighted relevance score (0-100): location match matters most, then
// budget fit, then property/transaction type. Simple and tunable - not a
// learned model, matches the brief's "simple relevance score" ask.
function scoreProperty(property, preferences) {
  const reasons = {};
  let score = 0;

  const locations = (preferences.preferred_locations || []).map((l) => l.toLowerCase());
  const locationMatch =
    locations.length > 0 &&
    (locations.includes((property.city || '').toLowerCase()) ||
      locations.includes((property.locality || '').toLowerCase()));
  if (locationMatch) score += 40;
  reasons.locationMatch = locationMatch;

  const price = Number(property.price);
  const budgetMin = preferences.budget_min != null ? Number(preferences.budget_min) : null;
  const budgetMax = preferences.budget_max != null ? Number(preferences.budget_max) : null;
  let budgetFit = 'unknown';
  if (budgetMin != null || budgetMax != null) {
    const withinRange = (budgetMin == null || price >= budgetMin) && (budgetMax == null || price <= budgetMax);
    if (withinRange) {
      budgetFit = 'within_range';
      score += 35;
    } else {
      // Partial credit for being close (within 20% of the nearer bound)
      const nearBound = budgetMax != null && price > budgetMax ? budgetMax : budgetMin;
      const withinTolerance = nearBound != null && Math.abs(price - nearBound) <= nearBound * 0.2;
      if (withinTolerance) {
        budgetFit = 'near_range';
        score += 15;
      } else {
        budgetFit = 'out_of_range';
      }
    }
  }
  reasons.budgetFit = budgetFit;

  const typeMatch = !preferences.property_type || preferences.property_type === property.property_type;
  if (preferences.property_type) {
    if (typeMatch) score += 15;
    reasons.typeMatch = typeMatch;
  }

  const transactionMatch = !preferences.transaction_type || preferences.transaction_type === property.transaction_type;
  if (preferences.transaction_type) {
    if (transactionMatch) score += 10;
    reasons.transactionMatch = transactionMatch;
  }

  return { score: Math.min(score, 100), reasons };
}

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

  const ranked = propertiesResult.rows
    .map((property) => ({ property, ...scoreProperty(property, preferences) }))
    .sort((a, b) => b.score - a.score)
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
      saved.push({ ...result.rows[0], property: entry.property });
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
