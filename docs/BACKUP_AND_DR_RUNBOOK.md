# Backups, restore tests and disaster recovery

Covers contract sections 25.4 (disaster recovery) and 25.5.1 (backups that survive a ransomware attack). The platform runs on Google Cloud (Cloud Run and Cloud SQL in `asia-south1`). The contract names AWS controls; this table shows the Google Cloud control used for each.

| Contract (AWS wording) | What is used on Google Cloud | Effect |
|---|---|---|
| Backups replicated to a separate AWS account | Backups go to a bucket in a **separate Google Cloud project** whose owners are not the day-to-day production admins | A compromised production account cannot reach them |
| S3 Object Lock (write-once storage) | **Bucket Lock**: a retention policy on the backup bucket, then locked | No one, including the project owner, can delete or overwrite a backup until its retention ends |
| MFA Delete | Google Cloud has no per-object MFA Delete. The locked retention policy is stronger: deletion is impossible, not merely gated by a second factor. On top of that, **2-step verification is enforced** for every person with access to the backup project, and the production job can only *create* objects (`storage.objectCreator`: no list, read or delete) | Equivalent or stronger protection |
| RPO 1 hour, RTO 4 hours | Cloud SQL **point-in-time recovery** (transaction logs, about 5-minute RPO) plus the daily off-site dump | Within target |

If production moves to AWS, the same jobs work against S3. Use a bucket in a second AWS account with Object Lock in compliance mode, MFA Delete on, and a bucket policy that lets the production role only call `s3:PutObject`.

## 1. One-time setup (Owner on both projects)

```bash
PROD_PROJECT=... BACKUP_PROJECT=... BUCKET=ps-db-backups-<suffix> SQL_INSTANCE=... \
  bash scripts/backup/setup-gcp.sh
```

The script:

1. Turns on daily Cloud SQL backups and point-in-time recovery.
2. Creates the backup bucket in the separate project (private, soft delete on, 35-day retention).
3. Creates two service accounts:
   - `ps-backup-writer`: may only create backups.
   - `ps-backup-reader`: may only read them, for restore tests.

It does **not** lock the retention policy yet.

## 2. First backup, first restore test, then lock

1. Build the job image. Set `PG_MAJOR` to the Cloud SQL Postgres version.

   ```bash
   docker build -f scripts/backup/Dockerfile --build-arg PG_MAJOR=16 \
     -t asia-south1-docker.pkg.dev/$PROD_PROJECT/cloud-run-source-deploy/ps-backup .
   ```

2. Create the backup job. It runs as `ps-backup-writer`, has the Cloud SQL connection and the same `DB_*` variables as the API, plus `BACKUP_GCS_BUCKET`, `BACKUP_GCS_PROJECT_ID` and `BACKUP_RETENTION_DAYS=35`.

   ```bash
   gcloud run jobs create ps-db-backup --image=.../ps-backup --region=asia-south1 \
     --service-account=ps-backup-writer@$PROD_PROJECT.iam.gserviceaccount.com \
     --set-cloudsql-instances=$PROD_PROJECT:asia-south1:$SQL_INSTANCE \
     --set-env-vars=DB_SOCKET_PATH=/cloudsql/$PROD_PROJECT:asia-south1:$SQL_INSTANCE,DB_NAME=...,DB_USER=...,BACKUP_GCS_BUCKET=$BUCKET,BACKUP_GCS_PROJECT_ID=$BACKUP_PROJECT \
     --set-secrets=DB_PASSWORD=db-password:latest --task-timeout=3600
   gcloud run jobs execute ps-db-backup --region=asia-south1 --wait
   ```

3. Schedule it daily at 02:00 IST:

   ```bash
   gcloud scheduler jobs create http ps-db-backup-daily --location=asia-south1 --schedule="30 20 * * *" --time-zone=UTC \
     --uri="https://run.googleapis.com/v2/projects/$PROD_PROJECT/locations/asia-south1/jobs/ps-db-backup:run" --http-method=POST \
     --oauth-service-account-email=ps-backup-writer@$PROD_PROJECT.iam.gserviceaccount.com
   ```

4. Run a restore test (section 4). When it passes, lock the bucket. **This cannot be undone.**

   ```bash
   LOCK=yes PROD_PROJECT=... BACKUP_PROJECT=... BUCKET=... SQL_INSTANCE=... bash scripts/backup/setup-gcp.sh
   ```

5. In the backup project, enforce 2-step verification for everyone who has access, and keep that list short. Write down who they are.

## 3. Watching it

- **CRM → Status** (admin) shows "Off-site backup":
  - a warning when the last good backup is older than `backup.max_age_hours` (26 h)
  - the check turns red at twice that age
- It also shows "Restore test", with a warning when the last passing test is older than `backup.restore_test_max_age_days` (35 days).
- Every run is a row in `backup_runs`. A failed job exits non-zero, which Cloud Run reports as a failed execution. Add a Cloud Monitoring alert on failed executions of `ps-db-backup`.

## 4. Restore test (before each release, and quarterly as the DR drill)

Restore into a **staging or scratch** Postgres server, never production. The script refuses if the target is the production server.

```bash
BACKUP_GCS_BUCKET=... BACKUP_GCS_PROJECT_ID=... GOOGLE_APPLICATION_CREDENTIALS=reader-key.json \
RESTORE_DB_HOST=staging-db RESTORE_DB_USER=... RESTORE_DB_PASSWORD=... \
DB_HOST=... DB_NAME=... DB_USER=... DB_PASSWORD=... \
  node scripts/backup/restoreTest.js
```

The script:

1. Downloads the newest backup.
2. Checks its SHA-256.
3. Restores it into a throw-away database.
4. Checks that the core tables have rows and that the last migration is present.
5. Drops the throw-away database.
6. Records the result and the time the restore took.

Put that time in the DR drill record. The contract's RTO is 4 hours.

## 5. Real recovery

| Situation | What to do |
|---|---|
| Bad data or a bad migration in the last 7 days | Cloud SQL point-in-time recovery to a new instance just before the event (`gcloud sql instances clone ... --point-in-time=...`). Check it, then point the API at it. |
| Production project compromised, or Cloud SQL backups gone | Create a new Cloud SQL instance, possibly in a new project. Use the reader identity to download the newest dump from the locked bucket, restore it with `pg_restore --no-owner`, redeploy the API with the new `DB_*` settings, and run `npm run migrate`. |
| Uploaded files (photos, documents) | The file bucket is separate from these database backups. Turn on object versioning and soft delete on `GCS_BUCKET_NAME`. If required, add a second locked bucket with Storage Transfer Service. |

After any real recovery, post a status-page update. Afterwards, write up what happened, how it was contained, how it was fixed and the lessons learned (contract 25.5.4).
