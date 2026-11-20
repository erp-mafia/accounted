#!/usr/bin/env bash
# Rebuild the MCP tool-integration database from scratch.
#
# Mirrors the pg-real CI job step for step (tests/pg/bootstrap.sql,
# supabase/bootstrap.sql, then every migration in filename order with
# ON_ERROR_STOP), so a schema that passes there passes here. Two additions:
#
#  * The container is recreated rather than the schemas dropped. Dropping is the
#    obvious approach and it does not work: `storage` is owned by
#    supabase_storage_admin, so `DROP SCHEMA storage` fails as postgres, and
#    dropping only `public` leaves the storage RLS policies that migration
#    20240101000024 creates unconditionally, which aborts the next replay
#    partway through and leaves a half-migrated database that looks like a
#    migration bug. A fresh volume costs about fifteen seconds and removes the
#    entire class.
#
#  * PostgREST caches the schema at boot, so a freshly-migrated database is
#    invisible to it until it is told to look again.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/tests/tool-pg/docker-compose.yml"

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

psql_run() {
  compose exec -T postgres \
    psql "postgresql://postgres:postgres@localhost:5432/postgres" -v ON_ERROR_STOP=1 -q "$@"
}

echo "==> recreating containers with a fresh volume"
compose down -v --remove-orphans >/dev/null 2>&1 || true
compose up -d --wait >/dev/null

echo "==> waiting for postgres"
for _ in $(seq 1 90); do
  if compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "==> bootstrap storage schema"
psql_run -f - < "$REPO_ROOT/tests/pg/bootstrap.sql" >/dev/null 2>&1

# The legacy platform default the historical migrations were written against;
# 20260929220000 switches it off again. No bulk GRANT after the replay: the
# database then carries the grants production has, so a tool that needs a
# grant prod lacks fails here with 42501 instead of in production.
echo "==> legacy default privileges for the replay"
psql_run -f - < "$REPO_ROOT/supabase/bootstrap.sql" >/dev/null

echo "==> applying migrations"
count=0
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  if ! psql_run -f - < "$f" >/dev/null 2>/tmp/tool-pg-migrate.err; then
    echo "FAILED on $(basename "$f")" >&2
    tail -20 /tmp/tool-pg-migrate.err >&2
    exit 1
  fi
  count=$((count + 1))
  if [ $((count % 200)) -eq 0 ]; then echo "    ... $count migrations applied"; fi
done
echo "==> $count migrations applied"

echo "==> reloading PostgREST schema cache"
psql_run -c "NOTIFY pgrst, 'reload schema';" >/dev/null
sleep 3

echo "==> ready"
