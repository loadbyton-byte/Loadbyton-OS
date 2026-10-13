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
  git fetch --quiet origin
  git checkout --quiet --detach "$1"
  if grep -q '^SENTRY_RELEASE=' .env.production; then sed -i "s/^SENTRY_RELEASE=.*/SENTRY_RELEASE=$1/" .env.production; else echo "SENTRY_RELEASE=$1" >> .env.production; fi
  "${C[@]}" up -d --build --remove-orphans
}
healthy() {
  for _ in $(seq 1 30); do
    if "${C[@]}" exec -T web wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1 \
      && "${C[@]}" exec -T worker wget -qO- http://127.0.0.1:3001/healthz >/dev/null 2>&1; then return 0; fi
    sleep 5
  done
  return 1
}

echo "deploying $SHA (previous $PREV)"
up "$SHA"
if healthy; then
  docker image prune -f >/dev/null
  echo "deploy ok: $SHA"
else
  echo "UNHEALTHY after deploy; rolling back to $PREV" >&2
  "${C[@]}" logs --tail=60 web >&2 || true
  up "$PREV"; healthy || echo "rollback also unhealthy" >&2
  exit 1
fi
