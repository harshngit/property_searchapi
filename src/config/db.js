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

module.exports = pool;