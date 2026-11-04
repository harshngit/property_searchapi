#!/usr/bin/env bash
# One-time setup of ransomware-resilient backups on Google Cloud - contract
# sec. 25.5.1. Read docs/BACKUP_AND_DR_RUNBOOK.md first. Run by someone with
# Owner on BOTH projects, from Cloud Shell or a machine with gcloud.
#
#   PROD_PROJECT     the project running the API and Cloud SQL
#   BACKUP_PROJECT   a SEPARATE project (ideally a separate billing account /
#                    organisation folder) whose owners are NOT the day-to-day
#                    production admins
#   REGION           asia-south1
#   BUCKET           globally unique bucket name in BACKUP_PROJECT
#   RETENTION_DAYS   how long every backup is write-once (default 35)
#   SQL_INSTANCE     Cloud SQL instance name in PROD_PROJECT
#
# The final step - locking the retention policy - CANNOT be undone (that is
# the point). It is only run when LOCK=yes is passed.
set -euo pipefail

: "${PROD_PROJECT:?}" "${BACKUP_PROJECT:?}" "${BUCKET:?}" "${SQL_INSTANCE:?}"
REGION="${REGION:-asia-south1}"
RETENTION_DAYS="${RETENTION_DAYS:-35}"
WRITER="ps-backup-writer"
READER="ps-backup-reader"

echo "== 1. Cloud SQL: automated daily backups + point-in-time recovery (RPO 1 hour or better)"
gcloud sql instances patch "$SQL_INSTANCE" --project="$PROD_PROJECT" \
  --backup-start-time=20:30 --enable-point-in-time-recovery --retained-backups-count=14 --retained-transaction-log-days=7

echo "== 2. Backup bucket in the separate project, uniform access, no public access, soft delete on"
gcloud storage buckets create "gs://$BUCKET" --project="$BACKUP_PROJECT" --location="$REGION" \
  --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=7d
gcloud storage buckets update "gs://$BUCKET" --retention-period="${RETENTION_DAYS}d"
# Older backups move to cheaper storage and are deleted a year after their lock ends.
cat > /tmp/ps-backup-lifecycle.json <<JSON
{"rule": [
  {"action": {"type": "SetStorageClass", "storageClass": "COLDLINE"}, "condition": {"age": 30}},
  {"action": {"type": "Delete"}, "condition": {"age": $((RETENTION_DAYS + 365))}}
]}
JSON
gcloud storage buckets update "gs://$BUCKET" --lifecycle-file=/tmp/ps-backup-lifecycle.json

echo "== 3. Identities: the production job may only CREATE backups; a separate reader restores them"
gcloud iam service-accounts create "$WRITER" --project="$PROD_PROJECT" --display-name="PropertySerch backup writer" || true
gcloud iam service-accounts create "$READER" --project="$BACKUP_PROJECT" --display-name="PropertySerch restore tester" || true
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$WRITER@$PROD_PROJECT.iam.gserviceaccount.com" --role="roles/storage.objectCreator"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$READER@$BACKUP_PROJECT.iam.gserviceaccount.com" --role="roles/storage.objectViewer"
gcloud projects add-iam-policy-binding "$PROD_PROJECT" --member="serviceAccount:$WRITER@$PROD_PROJECT.iam.gserviceaccount.com" --role="roles/cloudsql.client"

echo "== 4. Check: the writer must NOT be able to delete (expect 'does not have storage.objects.delete')"
gcloud storage buckets get-iam-policy "gs://$BUCKET" --format=json

if [ "${LOCK:-no}" = "yes" ]; then
  echo "== 5. LOCKING the retention policy - irreversible. Backups cannot be deleted for $RETENTION_DAYS days by anyone."
  gcloud storage buckets update "gs://$BUCKET" --lock-retention-period
else
  echo "== 5. Skipped locking. When the first backup and a restore test have passed, run again with LOCK=yes."
fi
echo "Done. Next: create the Cloud Run Jobs and the Cloud Scheduler trigger (runbook, section 3)."
