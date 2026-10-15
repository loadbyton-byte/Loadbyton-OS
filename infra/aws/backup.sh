#!/usr/bin/env bash
# Encrypted backup of the database + uploaded documents, copied to a Cloudflare R2 bucket. Run ON the server:
#   bash infra/aws/backup.sh setup          one time: R2 backups credentials
#   bash infra/aws/backup.sh                run a backup now
#   bash infra/aws/backup.sh install-cron   run it every night at 02:30
set -euo pipefail
export PATH="$PATH:/snap/bin"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
CFG=/etc/loadbyton-backup.env
OUT=/var/backups/loadbyton

case "${1:-run}" in
setup)
  read -rp "R2 Account ID: " a; a="$(echo -n "$a" | tr -d '[:space:]' | sed 's#^https\?://##; s#\..*$##')"
  read -rp "R2 backups bucket name [loadbyton-backups]: " b; b="$(echo -n "${b:-loadbyton-backups}" | tr -d '[:space:]')"
  read -rp "R2 Access Key ID (the BACKUPS token): " k; k="$(echo -n "$k" | tr -d '[:space:]')"
  read -rsp "R2 Secret Access Key (the BACKUPS token, hidden): " s; echo; s="$(echo -n "$s" | tr -d '[:space:]')"
  [ -n "$a" ] && [ -n "$k" ] && [ -n "$s" ] || { echo "Missing value. Nothing saved."; exit 1; }
  ( umask 077; printf 'R2_ACCOUNT_ID=%s\nR2_BUCKET=%s\nAWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\nAWS_DEFAULT_REGION=auto\n' "$a" "$b" "$k" "$s" > "$CFG" )
  echo "Saved to $CFG (key id ${#k} chars, secret ${#s} chars)."; exit 0;;
install-cron)
  printf 'PATH=/usr/local/bin:/usr/bin:/bin:/snap/bin\n30 2 * * * root /bin/bash %s/infra/aws/backup.sh >> /var/log/loadbyton-backup.log 2>&1\n' "$ROOT" > /etc/cron.d/loadbyton-backup
  chmod 644 /etc/cron.d/loadbyton-backup; echo "Nightly backup installed (02:30 server time). Log: /var/log/loadbyton-backup.log"; exit 0;;
run) ;;
*) echo "Usage: backup.sh [setup|install-cron]"; exit 2;;
esac

[ -f "$CFG" ] || { echo "Run first: bash infra/aws/backup.sh setup"; exit 1; }
set -a; . "$CFG"; set +a
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required   # R2 compatibility with the current AWS CLI
EP="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"

mkdir -p "$OUT"; chown 1000:1000 "$OUT"; chmod 700 "$OUT"
STAMP="$(mktemp)"; trap 'rm -f "$STAMP"' EXIT   # only a file written by THIS run may be uploaded and reported as OK
echo "[$(date -u +%FT%TZ)] building backup tools image..."
docker build -q -t loadbyton-backup:local -f infra/aws/Dockerfile.backup . >/dev/null
echo "[$(date -u +%FT%TZ)] creating encrypted backup..."
docker run --rm --read-only --tmpfs /tmp:rw,size=1g --env-file "$ROOT/.env.production" -e BACKUP_OUTPUT_DIR=/backups \
  -v "$OUT:/backups" loadbyton-backup:local node --import tsx scripts/backup.ts

NEW="$(find "$OUT" -name '*.lbt' -newer "$STAMP" -print 2>/dev/null | xargs -r ls -t | head -1)"
[ -n "$NEW" ] || { echo "No NEW backup file was created by this run (an older one must not be reported as today's backup)."; exit 1; }
echo "[$(date -u +%FT%TZ)] uploading $(basename "$NEW") ($(du -h "$NEW" | cut -f1)) to R2..."
aws s3 cp "$NEW" "s3://$R2_BUCKET/$(basename "$NEW")" --endpoint-url "$EP" --only-show-errors
aws s3 ls "s3://$R2_BUCKET/$(basename "$NEW")" --endpoint-url "$EP" >/dev/null && echo "[$(date -u +%FT%TZ)] backup OK: uploaded and found in R2."
find "$OUT" -name '*.lbt' -mtime +3 -delete
# Optional dead-man's switch: set BACKUP_HEARTBEAT_URL (e.g. a healthchecks.io check) in /etc/loadbyton-backup.env so a missed or failed night alerts someone.
[ -z "${BACKUP_HEARTBEAT_URL:-}" ] || curl -fsS -m 10 --retry 3 "$BACKUP_HEARTBEAT_URL" >/dev/null || echo "heartbeat ping failed"

