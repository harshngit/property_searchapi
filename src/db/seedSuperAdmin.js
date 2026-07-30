/**
 * One-time bootstrap script — creates the FIRST super_admin directly in
 * the database. Needed because the invite flow requires an existing
 * admin/super_admin to invite anyone, so the very first one has to be
 * seeded manually.
 *
 * Usage:
 *   SEED_NAME="Aniket" SEED_EMAIL="aniket@asynk.dev" SEED_PASSWORD="ChangeMe123!" node src/db/seedSuperAdmin.js
 *
 * Run this ONCE after `npm run migrate`. It is safe to re-run - it will
 * skip creation if a super_admin with that email already exists.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');

async function seedSuperAdmin() {
  const fullName = process.env.SEED_NAME || 'Super Admin';
  const email = process.env.SEED_EMAIL;
  const password = process.env.SEED_PASSWORD;

  if (!email || !password) {
    console.error('SEED_EMAIL and SEED_PASSWORD environment variables are required.');
    process.exit(1);
  }

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    console.log(`User with email ${email} already exists. Skipping.`);
    await pool.end();
    return;
  }

  const roleResult = await pool.query("SELECT id FROM roles WHERE name = 'super_admin'");
  if (roleResult.rows.length === 0) {
    console.error("Role 'super_admin' not found. Did you run the migrations first?");
    process.exit(1);
  }
  const roleId = roleResult.rows[0].id;

  const passwordHash = await bcrypt.hash(password, 10);

  const result = await pool.query(
    `INSERT INTO users (role_id, full_name, email, password_hash, status, email_verified)
     VALUES ($1, $2, $3, $4, 'active', true)
     RETURNING id, full_name, email, status, created_at`,
    [roleId, fullName, email, passwordHash]
  );

  console.log('Super admin created successfully:');
  console.log(result.rows[0]);
  await pool.end();
}

seedSuperAdmin().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
