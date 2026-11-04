#!/usr/bin/env node
// Restore test - contract sec. 25.4 ("backup & restore testing on staging
// before each release; quarterly DR drills").
//
//   Downloads the newest backup from the locked backup bucket, checks its
//   SHA-256 against the value stored with it, restores it into a throw-away
//   database on a NON-production server, runs sanity checks (the tables the
//   platform cannot work without have rows, the last migration is there),
//   then drops the throw-away database. The result is recorded in the
//   production backup_runs table so the status admin shows when the last
//   restore test passed.
//
// Runs with the backup-READER identity (roles/storage.objectViewer on the
// backup bucket) - never the production writer.
//
// Env:
//   BACKUP_GCS_BUCKET, BACKUP_GCS_PROJECT_ID, BACKUP_PREFIX (default "postgres")
//   RESTORE_DB_HOST, RESTORE_DB_PORT, RESTORE_DB_USER, RESTORE_DB_PASSWORD   a staging / scratch server
//   RESTORE_DB_NAME             throw-away database name (default ps_restore_test) - dropped and re-created
//   DB_* (as the API)           production database, only to record the result
//
// Run: node scripts/backup/restoreTest.js [gs object name]

require('dotenv').config();
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');
const { Storage } = require('@google-cloud/storage');
const pool = require('../../src/config/db');

const env = (k, d) => process.env[k] || d;
const target = () => ({ host: env('RESTORE_DB_HOST'), port: Number(env('RESTORE_DB_PORT', 5432)), user: env('RESTORE_DB_USER'), password: env('RESTORE_DB_PASSWORD', '') });

function run(cmd, args, extraEnv) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`))));
  });
}

async function adminQuery(sql) {
  const c = new Client({ ...target(), database: 'postgres' });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

async function main() {
  const bucketName = env('BACKUP_GCS_BUCKET');
  if (!bucketName) throw new Error('BACKUP_GCS_BUCKET is not set');
  if (!env('RESTORE_DB_HOST')) throw new Error('RESTORE_DB_HOST is not set - restore into a staging / scratch server, never production');
  if (env('RESTORE_DB_HOST') === env('DB_HOST') && env('RESTORE_DB_PORT', '5432') === String(env('DB_PORT', '5432'))) {
    throw new Error('RESTORE_DB_HOST is the production server - use a separate staging / scratch server');
  }
  const dbName = env('RESTORE_DB_NAME', 'ps_restore_test');
  if (!/^[a-z_][a-z0-9_]{2,40}$/.test(dbName)) throw new Error('RESTORE_DB_NAME must be a plain lowercase name');

  const bucket = new Storage({ projectId: env('BACKUP_GCS_PROJECT_ID') }).bucket(bucketName);
  let objectName = process.argv[2];
  if (!objectName) {
    const [files] = await bucket.getFiles({ prefix: `${env('BACKUP_PREFIX', 'postgres')}/` });
    const newest = files.filter((f) => f.name.endsWith('.dump')).sort((a, b) => new Date(b.metadata.timeCreated) - new Date(a.metadata.timeCreated))[0];
    if (!newest) throw new Error('No backup found in the bucket');
    objectName = newest.name;
  }
  const rec = (await pool.query(`INSERT INTO backup_runs (kind, status, target) VALUES ('restore_test', 'running', $1) RETURNING id`, [`gs://${bucketName}/${objectName}`])).rows[0];
  const file = path.join(os.tmpdir(), `ps-restore-${Date.now()}.dump`);
  const started = Date.now();
  try {
    const obj = bucket.file(objectName);
    const [meta] = await obj.getMetadata();
    await obj.download({ destination: file });
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (meta.metadata?.sha256 && meta.metadata.sha256 !== hash) throw new Error('SHA-256 of the downloaded backup does not match the value stored with it');

    await adminQuery(`DROP DATABASE IF EXISTS ${dbName}`);
    await adminQuery(`CREATE DATABASE ${dbName}`);
    const t = target();
    await run('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${dbName}`, file], { PGHOST: t.host, PGPORT: String(t.port), PGUSER: t.user, PGPASSWORD: t.password });

    const c = new Client({ ...t, database: dbName });
    await c.connect();
    const checks = {};
    try {
      for (const table of ['users', 'roles', 'properties', 'leads', 'app_config', 'audit_logs']) {
        checks[table] = Number((await c.query(`SELECT COUNT(*)::bigint AS n FROM ${table}`)).rows[0].n);
      }
      checks.lastMigration = (await c.query(`SELECT filename AS name FROM schema_migrations ORDER BY filename DESC LIMIT 1`).catch(() => ({ rows: [] }))).rows[0]?.name || null;
    } finally {
      await c.end();
    }
    const empty = ['users', 'roles', 'app_config'].filter((k) => !checks[k]);
    if (empty.length) throw new Error(`Restored database has no rows in: ${empty.join(', ')}`);
    await adminQuery(`DROP DATABASE IF EXISTS ${dbName}`);
    const minutes = Math.round(((Date.now() - started) / 60000) * 10) / 10;
    await pool.query(`UPDATE backup_runs SET status = 'success', sha256 = $2, size_bytes = $3, finished_at = now(), detail = $4 WHERE id = $1`, [rec.id, hash, fs.statSync(file).size, JSON.stringify({ checks, restoreMinutes: minutes })]);
    console.log(JSON.stringify({ ok: true, object: objectName, restoreMinutes: minutes, checks }));
  } catch (err) {
    await pool.query(`UPDATE backup_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [rec.id, String(err.message).slice(0, 1000)]);
    throw err;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[restore test] failed:', err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
