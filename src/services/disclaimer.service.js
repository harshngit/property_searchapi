const pool = require('../config/db');

// Returns the active disclaimers that apply to any of `contentTypes`, filtered
// by state when one is given (a disclaimer with no applicable_states applies
// everywhere). Used by the public /disclaimers endpoint and attached to API
// responses for auction, special-situation, investment and tax outputs so the
// frontend never needs its own copy of the text.
async function getDisclaimers(contentTypes = [], stateCode = null) {
  const types = (Array.isArray(contentTypes) ? contentTypes : [contentTypes]).filter(Boolean);
  const params = [];
  const where = ['is_active = true'];

  if (types.length > 0) {
    params.push(JSON.stringify(types));
    where.push(`applicable_content_types ?| ARRAY(SELECT jsonb_array_elements_text($${params.length}::jsonb))`);
  }
  if (stateCode) {
    params.push(JSON.stringify([String(stateCode).toUpperCase()]));
    where.push(`(applicable_states = '[]'::jsonb OR applicable_states @> $${params.length}::jsonb)`);
  }

  const result = await pool.query(
    `SELECT disclaimer_key AS key, title, content_html, is_mandatory
     FROM disclaimers WHERE ${where.join(' AND ')}
     ORDER BY sort_order ASC, disclaimer_key ASC`,
    params
  );
  return result.rows;
}

module.exports = { getDisclaimers };
