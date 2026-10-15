#!/usr/bin/env bash
# Runs ON the instance (as root) via SSM from .github/workflows/deploy.yml: ./deploy.sh <git-sha>
# Rolls forward to the given commit, rebuilds, waits for health, and rolls back to the previous commit if the new one is unhealthy.
set -euo pipefail
SHA="${1:?usage: deploy.sh <git-sha>}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "bad sha"; exit 2; }
cd /opt/loadbyton
C=(bash infra/aws/compose.sh)
PREV="$(git rev-parse HEAD)"

up() {
  # Capture the current schema using the previous revision before switching to code with pending migrations.
  if [[ "${2:-deploy}" = deploy ]]; then bash infra/aws/backup.sh || return $?; fi
  git fetch --quiet origin || return $?
  git checkout --quiet --detach "$1" || return $?
  if grep -q '^SENTRY_RELEASE=' .env.production; then sed -i "s/^SENTRY_RELEASE=.*/SENTRY_RELEASE=$1/" .env.production; else echo "SENTRY_RELEASE=$1" >> .env.production; fi
  "${C[@]}" build || return $?
  if [[ "${2:-deploy}" = deploy ]]; then
    "${C[@]}" run --rm --no-deps web npm run preflight || return $?
    "${C[@]}" run --rm --no-deps web npm run migrate || return $?
    "${C[@]}" run --rm --no-deps web npm run readiness -- --strict || return $?
  fi
  "${C[@]}" up -d --remove-orphans || return $?
}
healthy() {
  for _ in $(seq 1 30); do
    if "${C[@]}" exec -T web wget -qO- http://127.0.0.1:3000/readyz >/dev/null 2>&1 \
      && "${C[@]}" exec -T worker wget -qO- http://127.0.0.1:3001/readyz >/dev/null 2>&1; then return 0; fi
    sleep 5
  done
  return 1
}

echo "deploying $SHA (previous $PREV)"
if up "$SHA" && healthy; then
  docker image prune -f >/dev/null
  echo "deploy ok: $SHA"
else
  echo "UNHEALTHY after deploy; rolling back to $PREV" >&2
  "${C[@]}" logs --tail=60 web >&2 || true
  if ! up "$PREV" rollback || ! healthy; then echo "rollback also unhealthy; database migrations are not automatically reversed" >&2; fi
  exit 1
fi
