#!/usr/bin/env node
// Off-site database backup - contract sec. 25.4 / 25.5.1.
//
//   pg_dump (custom format) of the production database -> SHA-256 ->
//   uploaded to the BACKUP bucket, which lives in a SEPARATE Google Cloud
//   project with a LOCKED retention policy (Bucket Lock = write-once storage:
//   nobody, not even a project owner, can delete or overwrite an object
//   before its retention ends). The identity running this job may only CREATE
//   objects there (roles/storage.objectCreator) - it cannot list, read or
//   delete backups, so a compromised production account cannot destroy them.
//   See docs/BACKUP_AND_DR_RUNBOOK.md for the one-time setup.
//
// Every run is recorded in backup_runs (shown on the CRM status admin).
//
// Env:
//   DB_HOST / DB_SOCKET_PATH, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD   (same as the API)
//   BACKUP_GCS_BUCKET            the locked bucket in the backup project
//   BACKUP_GCS_PROJECT_ID        the backup project
//   BACKUP_RETENTION_DAYS        what the bucket's locked retention is (for the record; default 35)
//   BACKUP_PREFIX                object name prefix (default "postgres")
//   GOOGLE_APPLICATION_CREDENTIALS  key of the backup-writer service account, when not on Cloud Run
//
// Run: node scripts/backup/backup.js   (a Cloud Run Job on a daily Cloud Scheduler trigger)

require('dotenv').config();
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const pool = require('../../src/config/db');

const env = (k, d) => process.env[k] || d;

function dump(file) {
  return new Promise((resolve, reject) => {
    const args = ['--format=custom', '--no-owner', '--no-privileges', '--compress=6', `--file=${file}`, `--dbname=${env('DB_NAME')}`];
    const proc = spawn('pg_dump', args, {
      env: {
        ...process.env,
        PGHOST: env('DB_SOCKET_PATH', env('DB_HOST', 'localhost')),
        PGPORT: String(env('DB_PORT', 5432)),
        PGUSER: env('DB_USER'),
        PGPASSWORD: env('DB_PASSWORD', ''),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code}: ${err.slice(-500)}`))));
  });
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function main() {
  const bucketName = env('BACKUP_GCS_BUCKET');
  if (!bucketName) throw new Error('BACKUP_GCS_BUCKET is not set');
  const retentionDays = Number(env('BACKUP_RETENTION_DAYS', 35));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const objectName = `${env('BACKUP_PREFIX', 'postgres')}/${stamp.slice(0, 7)}/${env('DB_NAME')}-${stamp}.dump`;
  const run = (await pool.query(`INSERT INTO backup_runs (kind, status, target) VALUES ('backup', 'running', $1) RETURNING id`, [`gs://${bucketName}/${objectName}`])).rows[0];
  const file = path.join(os.tmpdir(), `ps-backup-${stamp}.dump`);
  try {
    await dump(file);
    const size = fs.statSync(file).size;
    if (size < 1024) throw new Error(`The dump is only ${size} bytes - refusing to record it as a good backup`);
    const hash = await sha256(file);
    const storage = new Storage({ projectId: env('BACKUP_GCS_PROJECT_ID') });
    // ifGenerationMatch: 0 = create only, never overwrite an existing object.
    await storage.bucket(bucketName).upload(file, {
      destination: objectName,
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { contentType: 'application/octet-stream', metadata: { sha256: hash, database: env('DB_NAME'), createdAt: new Date().toISOString() } },
      resumable: size > 8 * 1024 * 1024,
    });
    await pool.query(
      `UPDATE backup_runs SET status = 'success', size_bytes = $2, sha256 = $3, retain_until = now() + make_interval(days => $4), finished_at = now(), detail = $5 WHERE id = $1`,
      [run.id, size, hash, retentionDays, JSON.stringify({ object: objectName, pgDump: 'custom' })]
    );
    console.log(JSON.stringify({ ok: true, object: `gs://${bucketName}/${objectName}`, size, sha256: hash }));
  } catch (err) {
    await pool.query(`UPDATE backup_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [run.id, String(err.message).slice(0, 1000)]);
    throw err;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[backup] failed:', err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
