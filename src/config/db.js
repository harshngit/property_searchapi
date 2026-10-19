const { Pool, types } = require('pg');
require('dotenv').config();

// DATE columns (effective_from, lease dates, ...) are calendar dates with no
// time zone. pg's default parser turns them into a JS Date at local
// midnight, which serialises as the previous day in UTC on an IST server -
// return the raw 'YYYY-MM-DD' string instead. (1082 = DATE's type OID.)
types.setTypeParser(1082, (value) => value);

const pool = new Pool({
  host: process.env.DB_SOCKET_PATH || process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

// Franchise isolation (Section 14.9, Row-Level Security - migration 074).
// Inside franchiseScope.run({ franchiseeId }, ...) every pool.query runs in its
// own transaction with app.franchisee_id set, so the database itself returns
// only that franchisee's rows from the franchise-scoped tables. Everywhere
// else nothing changes.
const { AsyncLocalStorage } = require('async_hooks');
const franchiseScope = new AsyncLocalStorage();
const plainQuery = pool.query.bind(pool);
pool.query = function scopedQuery(text, params, callback) {
  const scope = franchiseScope.getStore();
  if (!scope?.franchiseeId || typeof params === 'function' || typeof callback === 'function') return plainQuery(text, params, callback);
  return (async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.franchisee_id', $1, true), set_config('app.franchise_tenant_id', $2, true)`, [String(scope.franchiseeId), scope.tenantId ? String(scope.tenantId) : '']);
      const result = await client.query(text, params);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  })();
};
pool.franchiseScope = franchiseScope;

module.exports = pool;