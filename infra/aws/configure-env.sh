#!/usr/bin/env bash
# Guided setup of /opt/loadbyton/.env.production. Run ON the server as root:  bash infra/aws/configure-env.sh
# Asks one question at a time, generates the secret keys, writes values safely. Safe to re-run: Enter keeps the current value.
set -euo pipefail
cd "$(dirname "$0")/../.."
F=.env.production
[ -f "$F" ] || cp .env.example "$F"
chmod 600 "$F"

setv() { # setv KEY VALUE  (python avoids every shell/sed quoting trap)
  K="$1" V="$2" python3 - "$F" <<'PY'
import os, re, sys
p, k, v = sys.argv[1], os.environ["K"], os.environ["V"]
out, done = [], False
for l in open(p).read().split("\n"):
    if re.match(r"^" + re.escape(k) + r"=", l):
        if not done: out.append(k + "=" + v); done = True
    else: out.append(l)
if not done: out.append(k + "=" + v)
open(p, "w").write("\n".join(out).rstrip("\n") + "\n")
PY
}
getv() { grep -m1 "^$1=" "$F" | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' || true; }
bad() { case "$1" in *'$'*|*' #'*|*'"'*|*"'"*) return 0;; esac; return 1; }

# Long pastes through the AWS terminal can arrive in pieces: after the first line, keep appending any piece that follows within 2 seconds.
ask() { # ask KEY "question" [secret]
  local k="$1" q="$2" secret="${3:-}" cur v part
  cur="$(getv "$k")"
  while true; do
    if [ -n "$cur" ]; then
      if [ "$secret" = secret ]; then q2="$q [already set - Enter to keep]"; else q2="$q [$cur - Enter to keep]"; fi
    else q2="$q [Enter to skip]"; fi
    if [ "$secret" = secret ]; then IFS= read -rsp "$q2: " v || true; echo; else IFS= read -rp "$q2: " v || true; fi
    v="$(echo -n "$v" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -z "$v" ] && return 0
    while IFS= read -rs -t 2 part; do
      part="$(echo -n "$part" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      [ -z "$part" ] && break
      v="$v$part"
    done
    if bad "$v"; then echo "  Value must not contain \$ or quotes or ' #'. Try again."; continue; fi
    case "$k" in DATABASE_URL|MIGRATION_DATABASE_URL)
      if ! python3 -c "import sys,urllib.parse as u;p=u.urlsplit(sys.argv[1]);sys.exit(0 if p.scheme in('postgres','postgresql') and p.hostname and '.' in p.hostname and p.port else 1)" "$v"; then
        echo "  That does not look like a full database address (needs postgresql://user:password@host:port/postgres). Paste it again."; continue; fi;;
    esac
    echo "  saved (${#v} characters)"
    setv "$k" "$v"; return 0
  done
}
secretgen() { # keep existing real secret, else generate
  local cur; cur="$(getv "$1")"
  case "$cur" in ""|change-me*|dev-only*) setv "$1" "$(openssl rand -hex 32)";; esac
}

if [ "${1:-}" = check ]; then
  echo "== Settings check (no secret values shown) =="
  for k in ROOT_DOMAIN PUBLIC_BASE_URL DATABASE_URL MIGRATION_DATABASE_URL S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN SENTRY_DSN \
           CLOUDFLARE_TUNNEL_TOKEN CLOUDFLARE_ZONE_ID CLOUDFLARE_API_TOKEN CLOUDFLARE_ORIGIN_HOSTNAME PAYMENT_PROVIDERS STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET RAZORPAY_KEY_ID LEGAL_REVIEWED; do
    v="$(getv "$k")"
    if [ -z "$v" ]; then printf '  %-28s EMPTY\n' "$k"; continue; fi
    case "$k" in
      DATABASE_URL|MIGRATION_DATABASE_URL) python3 -c "import sys,urllib.parse as u;p=u.urlsplit(sys.argv[2]);print('  %-28s host=%s port=%s user=%s... pw=%s'%(sys.argv[1],p.hostname,p.port,(p.username or '')[:12],'yes' if p.password else 'NO'))" "$k" "$v" || echo "  $k UNPARSEABLE";;
      ROOT_DOMAIN|PUBLIC_BASE_URL|S3_ENDPOINT|S3_BUCKET|CLOUDFLARE_ORIGIN_HOSTNAME|PAYMENT_PROVIDERS|LEGAL_REVIEWED|UPSTASH_REDIS_REST_URL) printf '  %-28s %s\n' "$k" "$v";;
      *) printf '  %-28s set (%s characters, starts %s...)\n' "$k" "${#v}" "${v:0:4}";;
    esac
  done
  echo
  echo "Typical lengths: tunnel token 150+, Stripe secret key ~107, Sentry DSN ~90, R2 secret 64, Cloudflare API token 40, Zone ID 32."
  exit 0
fi

echo "== LOAD|BY|TON production settings =="
echo "Paste each value and press Enter. Secrets are hidden while you type."
echo

echo "-- Fixed settings"
setv NODE_ENV production; setv PORT 3000
setv STORAGE_DRIVER s3; setv S3_REGION auto; setv S3_PATH_STYLE true
setv DATABASE_SSL require; setv MIGRATE_ON_START true
setv TRUST_PROXY cloudflare; setv CLAMAV_HOST scanner
setv REQUIRE_COMPANY_MFA true; setv DATA_RETENTION_DAYS 90
setv DEPLOYMENT_REGION "AWS eu-north-1 (Stockholm)"
setv MAIL_PROVIDER log; setv SMS_PROVIDER log; setv WHATSAPP_PROVIDER log
setv SENTRY_ENVIRONMENT production
setv BACKUP_OUTPUT_DIR ./backups
setv SENTRY_RELEASE "$(git rev-parse HEAD 2>/dev/null || echo unknown)"

echo "-- Secret keys (generated here, never typed)"
secretgen SESSION_SECRET; secretgen PAYMENT_WEBHOOK_SECRET
secretgen MFA_ENCRYPTION_KEY; secretgen BACKUP_ENCRYPTION_KEY
cur="$(getv METRICS_TOKEN)"; [ -n "$cur" ] || setv METRICS_TOKEN "$(openssl rand -hex 24)"

echo
echo "-- Your domain"
read -rp "Domain without www or https, e.g. loadbyton.com [$(getv ROOT_DOMAIN)]: " d
d="$(echo -n "$d" | tr 'A-Z' 'a-z' | sed 's/^https\?:\/\///;s/^www\.//;s/\/.*$//;s/[[:space:]]//g')"
if [ -n "$d" ]; then setv ROOT_DOMAIN "$d"; setv PUBLIC_BASE_URL "https://www.$d"; fi

echo
echo "-- Database (Supabase)"
echo "Long addresses cannot be pasted reliably here, so type 3 short pieces. In the Supabase string"
echo "  postgresql://postgres.PROJECTREF:[YOUR-PASSWORD]@HOST:6543/postgres"
echo "HOST is the text after the @ (before :6543). PROJECTREF is the text between 'postgres.' and the ':'."
IFS= read -rp "  HOST, e.g. aws-0-eu-north-1.pooler.supabase.com [Enter to keep current]: " dbh || true
dbh="$(echo -n "$dbh" | tr -d '[:space:]')"
if [ -n "$dbh" ]; then
  IFS= read -rp "  PROJECTREF (about 20 letters/numbers): " dbr || true
  IFS= read -rsp "  Database PASSWORD (hidden): " dbp || true; echo
  dbr="$(echo -n "$dbr" | tr -d '[:space:]')"; dbp="$(echo -n "$dbp" | tr -d '\r')"
  if DBH="$dbh" DBR="$dbr" DBP="$dbp" python3 - "$F" <<'PY'
import os, re, sys, urllib.parse as u
h, r, p = os.environ["DBH"], os.environ["DBR"], os.environ["DBP"]
if not re.fullmatch(r"[A-Za-z0-9.-]+\.[A-Za-z]{2,}", h) or not re.fullmatch(r"[A-Za-z0-9]{10,40}", r) or not p:
    print("  Something looks wrong (host, project ref or password). Nothing saved. Run the script again."); sys.exit(1)
def put(k, v):
    t = open(sys.argv[1]).read().split("\n"); out = []; done = False
    for l in t:
        if re.match("^" + k + "=", l):
            if not done: out.append(k + "=" + v); done = True
        else: out.append(l)
    if not done: out.append(k + "=" + v)
    open(sys.argv[1], "w").write("\n".join(out).rstrip("\n") + "\n")
q = u.quote(p, safe="")
put("DATABASE_URL", f"postgresql://postgres.{r}:{q}@{h}:6543/postgres")
put("MIGRATION_DATABASE_URL", f"postgresql://postgres.{r}:{q}@{h}:5432/postgres")
print("  saved both database addresses (transaction 6543, session 5432)")
PY
  then :; fi
fi

echo
echo "-- File storage (Cloudflare R2)"
read -rp "R2 Account ID [$(getv S3_ENDPOINT)]: " a
a="$(echo -n "$a" | tr -d '[:space:]' | sed 's#^https\?://##; s#\..*$##')"   # accepts the bare Account ID or a pasted full address
[ -z "$a" ] || setv S3_ENDPOINT "https://$a.r2.cloudflarestorage.com"
cur="$(getv S3_BUCKET)"; [ -n "$cur" ] || setv S3_BUCKET loadbyton-files
ask S3_ACCESS_KEY_ID "R2 Access Key ID (files bucket token)" secret
ask S3_SECRET_ACCESS_KEY "R2 Secret Access Key (files bucket token)" secret

echo
echo "-- Rate limits (Upstash)"
ask UPSTASH_REDIS_REST_URL "Upstash REST URL"
ask UPSTASH_REDIS_REST_TOKEN "Upstash REST token" secret

echo
echo "-- Error reporting (Sentry)"
ask SENTRY_DSN "Sentry DSN" secret

echo
echo "-- Cloudflare"
ask CLOUDFLARE_TUNNEL_TOKEN "Tunnel token" secret
ask CLOUDFLARE_ZONE_ID "Zone ID (domain overview page, right column)"
ask CLOUDFLARE_API_TOKEN "API token (DNS read)" secret
read -rp "Tunnel ID (looks like 1a2b3c4d-....) [$(getv CLOUDFLARE_ORIGIN_HOSTNAME)]: " t
t="$(echo -n "$t" | tr -d '[:space:]')"
[ -z "$t" ] || setv CLOUDFLARE_ORIGIN_HOSTNAME "$t.cfargotunnel.com"

echo
echo "-- Payments (the app refuses to start with none; test keys work for a first run)"
read -rp "Provider: razorpay or stripe [$(getv PAYMENT_PROVIDERS)]: " p
p="$(echo -n "$p" | tr 'A-Z' 'a-z' | tr -d '[:space:]')"
case "$p" in
  razorpay) setv PAYMENT_PROVIDERS razorpay
    ask RAZORPAY_KEY_ID "Razorpay Key ID (rzp_test_... or rzp_live_...)"
    ask RAZORPAY_KEY_SECRET "Razorpay Key Secret" secret
    ask RAZORPAY_WEBHOOK_SECRET "Webhook secret (any text you choose, 8+ characters; reuse it in the Razorpay dashboard)" secret;;
  stripe) setv PAYMENT_PROVIDERS stripe
    ask STRIPE_SECRET_KEY "Stripe secret key (sk_test_... or sk_live_...)" secret
    ask STRIPE_WEBHOOK_SECRET "Stripe webhook signing secret (whsec_...)" secret;;
  "") ;;
  *) echo "Unknown provider, skipped." ;;
esac
if grep -qE '^(RAZORPAY_KEY_ID=rzp_test_|STRIPE_SECRET_KEY=sk_test_)' "$F"; then
  setv ALLOW_TEST_PAYMENT_KEYS true
  echo "  Test keys detected: ALLOW_TEST_PAYMENT_KEYS=true (no real money moves). Remove it before going live."
fi

echo
echo "-- Legal confirmation"
echo "The app will not start in production until you confirm that your privacy policy, terms and"
echo "data-retention (90 days) have been reviewed by you or your adviser."
read -rp "Type yes only if that is true [$(getv LEGAL_REVIEWED)]: " l
[ "$l" = yes ] && setv LEGAL_REVIEWED true

echo
echo "-- Seller details shown on receipts (optional, Enter to skip each)"
ask SELLER_LEGAL_NAME "Legal company name"
ask SELLER_TRADE_NAME "Trade name"
ask SELLER_ADDRESS "Address"
ask SELLER_SUPPORT_EMAIL "Support email"

echo
echo "== Done. Still empty (needed for the app to start): =="
miss=0
for k in ROOT_DOMAIN PUBLIC_BASE_URL DATABASE_URL MIGRATION_DATABASE_URL S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY \
         CLOUDFLARE_TUNNEL_TOKEN CLOUDFLARE_ZONE_ID CLOUDFLARE_API_TOKEN CLOUDFLARE_ORIGIN_HOSTNAME PAYMENT_PROVIDERS LEGAL_REVIEWED; do
  v="$(getv "$k")"; if [ -z "$v" ] || [ "$v" = mock ] || [ "$v" = false ]; then echo "  - $k"; miss=1; fi
done
[ "$miss" = 0 ] && echo "  (nothing - all required values are set)"
echo
echo "SAVE THESE TWO KEYS in your private notes NOW. If the server is lost, backups and 2-step logins cannot be recovered without them:"
echo "  BACKUP_ENCRYPTION_KEY=$(getv BACKUP_ENCRYPTION_KEY)"
echo "  MFA_ENCRYPTION_KEY=$(getv MFA_ENCRYPTION_KEY)"
echo
echo "Run 'bash infra/aws/configure-env.sh' again any time to fill the rest."
