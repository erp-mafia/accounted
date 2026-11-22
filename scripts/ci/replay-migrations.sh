#!/usr/bin/env bash
# Applies the given migration files, in the order given, to $DATABASE_URL over
# ONE psql connection, which is where one psql per file spent most of its time.
# Between two files DISCARD ALL resets the session to the state a new connection
# starts in: search_path and every other setting back to the connection's own
# (PGOPTIONS included), the role back to the login role, temp tables, prepared
# statements, cursors, LISTENs and advisory locks gone. One difference stays: a
# setting an earlier file stores for the login role or the database (ALTER ROLE
# or ALTER DATABASE ... SET) reaches a new connection, not this one.
#
# The first failing statement stops the replay and psql names the file and the
# line. A file that leaves a transaction open fails too (DISCARD ALL cannot run
# inside a transaction block), where one psql per file would have rolled it
# back without a word.
#
# Usage: scripts/ci/replay-migrations.sh <file.sql>...
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "replay-migrations: no files given" >&2
  exit 1
fi

script=$(mktemp)
trap 'rm -f "$script"' EXIT
{
  for f in "$@"; do
    printf '\\i %s\nDISCARD ALL;\n' "$f"
  done
} > "$script"

started=$(date +%s)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$script" >/dev/null
echo "Applied $# migration file(s) in $(( $(date +%s) - started )) s"
