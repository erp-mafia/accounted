#!/usr/bin/env bash
# Rebuild the MCP tool-integration database from scratch.
#
# Mirrors the pg-real CI job step for step (bootstrap.sql, then every migration
# in filename order with ON_ERROR_STOP), so a schema that passes there passes
# here. Two additions:
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

# The image grants these at init, but DEFAULT PRIVILEGES are what make the
# grants apply to the ~400 tables the migrations are about to create. Without
# them PostgREST answers every request with 42501 "permission denied".
echo "==> default privileges for the supabase roles"
psql_run -c "
  GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON ROUTINES TO postgres, anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
" >/dev/null

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

# NOTE: this blanket grant includes `anon`, which PostgREST needs to answer at
# all. It also means THIS DATABASE IS NOT VALID FOR THE pg-real SUITE: ~29 of
# those files assert least privilege ("does not grant EXECUTE to anon"), and
# they fail here on unmodified main. Point `npm run test:pg` at its own
# database, not at this one.
echo "==> granting on everything the migrations created"
psql_run -c "
  GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, anon, authenticated, service_role;
  GRANT ALL ON ALL ROUTINES IN SCHEMA public TO postgres, anon, authenticated, service_role;
  GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, anon, authenticated, service_role;
" >/dev/null

echo "==> reloading PostgREST schema cache"
psql_run -c "NOTIFY pgrst, 'reload schema';" >/dev/null
sleep 3

echo "==> ready"
