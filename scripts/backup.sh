#!/usr/bin/env bash
# Nightly logical backup of the database and the uploaded documents, with 14-day retention.
#   crontab:  17 2 * * *  cd /opt/loadbyton && ./scripts/backup.sh >> /var/log/lbt-backup.log 2>&1
# Needs: pg_dump (postgresql-client), a DIRECT (non-pooled) connection string, and somewhere off the VM to copy to
# (Oracle Object Storage via the OCI CLI, or rclone to any bucket). A backup is only real once you have restored it:
# see docs/RUNBOOKS.md "Restore test".
set -euo pipefail
: "${BACKUP_DATABASE_URL:?set BACKUP_DATABASE_URL (the direct Postgres URL, e.g. MIGRATION_DATABASE_URL)}"
DEST="${BACKUP_DIR:-/var/backups/loadbyton}"
FILES="${STORAGE_VOLUME:-/var/lib/docker/volumes/loadbyton_files/_data}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "$DEST"
pg_dump --format=custom --no-owner --dbname="$BACKUP_DATABASE_URL" --file="$DEST/db-$STAMP.dump"
tar -C "$FILES" -czf "$DEST/files-$STAMP.tar.gz" .
# optional off-box copy, e.g.:  rclone copy "$DEST" remote:loadbyton-backups --max-age 2d
find "$DEST" -type f -mtime +14 -delete
echo "backup $STAMP ok: $(du -h "$DEST/db-$STAMP.dump" | cut -f1) db, $(du -h "$DEST/files-$STAMP.tar.gz" | cut -f1) files"
