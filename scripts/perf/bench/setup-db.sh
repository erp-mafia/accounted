#!/bin/sh
# Builds the report benchmark's database on an empty supabase/postgres:17
# container: the pg-real replay (bootstrap, every migration), then the seed.
# THROWAWAY DATABASE ONLY. Connection from the libpq environment (PGHOST,
# PGPORT, PGPASSWORD, PGDATABASE); run from the repository root.
#
#   CI:    PGHOST=postgres PGPASSWORD=postgres sh scripts/perf/bench/setup-db.sh
#   local: docker exec -w /repo accounted-bench-pg17 sh scripts/perf/bench/setup-db.sh
#
# Extra psql variables for the seed go in BENCH_SEED_ARGS, for example
# BENCH_SEED_ARGS="-v per_year=5000 -v bg_tenants=0" for a quick run.
set -eu

PSQL="psql -X -q -v ON_ERROR_STOP=1 -d ${PGDATABASE:-postgres}"

# The image initialises and restarts once; wait until it answers twice.
i=0
until $PSQL -U postgres -tAc 'select 1' >/dev/null 2>&1 && sleep 3 && $PSQL -U postgres -tAc 'select 1' >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 90 ] || { echo "Postgres did not come up"; exit 1; }
  sleep 2
done
$PSQL -U postgres -tAc 'select version()'

start=$(date +%s)
# tests/pg/bootstrap.sql adds what GoTrue and storage-api would create. On
# the 17 image postgres may not alter auth.users or create in storage (the
# 15 image pg-real uses lets it), so this step runs as the image's
# superuser and then hands storage's two tables to postgres, as storage-api
# grants them on a hosted project.
$PSQL -U supabase_admin -f tests/pg/bootstrap.sql
$PSQL -U supabase_admin -c 'ALTER TABLE storage.buckets OWNER TO postgres' \
  -c 'ALTER TABLE storage.objects OWNER TO postgres' \
  -c 'GRANT USAGE ON SCHEMA storage TO postgres, anon, authenticated, service_role'

# The migrations as prod applies them: as postgres, in file order.
$PSQL -U postgres -f supabase/bootstrap.sql
n=0
for f in supabase/migrations/*.sql; do
  $PSQL -U postgres -f "$f" >/dev/null 2>/tmp/bench-migration.err || {
    echo "Failed applying $f"; grep -v '^NOTICE' /tmp/bench-migration.err | head -20; exit 1;
  }
  n=$((n + 1))
done
echo "setup-db: $n migrations in $(($(date +%s) - start)) s"

start=$(date +%s)
# shellcheck disable=SC2086
$PSQL -U postgres ${BENCH_SEED_ARGS:-} -f scripts/perf/bench/seed.sql
echo "setup-db: seed in $(($(date +%s) - start)) s"
