#!/usr/bin/env bash
# Runs docker compose for production with the right files, from anywhere:  bash infra/aws/compose.sh ps | up -d --build | logs --tail 40 web
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$ROOT/.env.production" ] || { echo "Missing $ROOT/.env.production - run: bash infra/aws/configure-env.sh" >&2; exit 1; }
# compose.yml reads env_file relative to ops/production, so link the real file there (idempotent)
ln -sf "$ROOT/.env.production" "$ROOT/ops/production/.env.production"
exec docker compose -f "$ROOT/ops/production/compose.yml" --env-file "$ROOT/.env.production" "$@"
