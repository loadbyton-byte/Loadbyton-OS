#!/usr/bin/env bash
# Adds Supabase's certificate authority to .env.production (DATABASE_CA) after proving it validates YOUR database. Run on the server:
#   bash infra/aws/supabase-ca.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
F=.env.production
URL="${SUPABASE_CA_URL:-https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt}"
CA=/tmp/supabase-ca.crt

DBURL="$(grep -m1 '^DATABASE_URL=' "$F" | cut -d= -f2-)"
read -r HOST PORT < <(python3 -c "import sys,urllib.parse as u;p=u.urlsplit(sys.argv[1]);print(p.hostname,p.port or 5432)" "$DBURL")
[ -n "${HOST:-}" ] || { echo "DATABASE_URL has no host. Run: bash infra/aws/configure-env.sh"; exit 1; }

echo "Downloading Supabase certificate..."
curl -fsS -m 30 -o "$CA" "$URL"
grep -q 'BEGIN CERTIFICATE' "$CA" || { echo "Download is not a certificate."; exit 1; }

echo "Testing it against $HOST:$PORT ..."
RES="$(openssl s_client -connect "$HOST:$PORT" -starttls postgres -CAfile "$CA" -verify_return_error </dev/null 2>&1 || true)"
echo "$RES" | grep -E "Verification|Verify return code" | head -3
if ! echo "$RES" | grep -qE "Verify return code: 0|Verification: OK"; then
  echo
  echo "The certificate did NOT validate your database. Nothing was saved."
  echo "Copy the lines above and send them to your helper."
  exit 1
fi

python3 - "$F" "$CA" <<'PY'
import re, sys
p, ca = sys.argv[1], sys.argv[2]
pem = open(ca).read().strip().replace("\r", "")
val = pem.replace("\n", "\\n")          # the app expects literal \n between lines
lines = open(p).read().split("\n"); out = []; done = False
for l in lines:
    if l.startswith("DATABASE_CA="):
        if not done: out.append("DATABASE_CA=" + val); done = True
    else: out.append(l)
if not done: out.append("DATABASE_CA=" + val)
open(p, "w").write("\n".join(out).rstrip("\n") + "\n")
print("Saved DATABASE_CA (%d characters)." % len(val))
PY
echo "Done. Now restart:  bash infra/aws/compose.sh up -d --build"
