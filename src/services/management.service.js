const pool = require('../config/db');

// City Head (CH) and Area Head (AH) - contract sec. 33.3 Band B. A CH holds
// the cities in assigned_cities; an AH the localities in coverage_localities
// (within assigned_cities, when given). Admins and the Super Admin hold
// everything. Used wherever the contract names "City Head / Area Head":
// related-party review, manual reassignment, mandate renewal past the cap and
// the cascade's escalation alerts.

const ALL_ROLES = ['admin', 'super_admin'];
const norm = (v) => String(v || '').trim().toLowerCase();

async function headOf(userId) {
  if (!userId) return null;
  const r = (await pool.query(
    `SELECT ar.designation, ar.assigned_cities, ar.coverage_localities FROM arb_representatives ar JOIN users u ON u.id = ar.user_id AND u.status = 'active' WHERE ar.user_id = $1`,
    [userId]
  )).rows[0];
  return r || null;
}

// What this person oversees: { all } | { designation, cities, localities } | null.
async function scopeOf(user) {
  if (!user) return null;
  if (ALL_ROLES.includes(user.role)) return { all: true };
  const h = await headOf(user.id);
  if (!h || !['ch', 'ah'].includes(h.designation)) return null;
  return { designation: h.designation, cities: (h.assigned_cities || []).map(norm), localities: (h.coverage_localities || []).map(norm) };
}

// Is a record in this place within the scope? A CH needs the city; an AH the
// locality (and the city too, when the AH has cities set).
function covers(scope, { city, locality } = {}) {
  if (!scope) return false;
  if (scope.all) return true;
  const c = norm(city);
  const l = norm(locality);
  if (scope.designation === 'ch') return !!c && scope.cities.includes(c);
  if (!l || !scope.localities.includes(l)) return false;
  return !scope.cities.length || (!!c && scope.cities.includes(c));
}

async function canOversee(user, place) {
  return covers(await scopeOf(user), place);
}

// The heads for a place: the City Head(s) of the city and the Area Head(s) of the locality.
async function headsFor({ city, locality } = {}) {
  if (!city && !locality) return [];
  const r = await pool.query(
    `SELECT ar.user_id FROM arb_representatives ar JOIN users u ON u.id = ar.user_id AND u.status = 'active'
     WHERE (ar.designation = 'ch' AND $1::text IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(ar.assigned_cities) x WHERE lower(x) = lower($1)))
        OR (ar.designation = 'ah' AND $2::text IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(ar.coverage_localities) x WHERE lower(x) = lower($2))
            AND (cardinality(ar.assigned_cities) = 0 OR $1::text IS NULL OR EXISTS (SELECT 1 FROM unnest(ar.assigned_cities) x WHERE lower(x) = lower($1))))`,
    [city || null, locality || null]
  );
  return r.rows.map((x) => x.user_id);
}

// Team Leaders may reassign too (sec. 34: "manual reassignment only by TL/AH/CH").
async function isTeamLeader(userId) {
  return (await headOf(userId))?.designation === 'tl';
}

module.exports = { scopeOf, covers, canOversee, headsFor, isTeamLeader, headOf };
