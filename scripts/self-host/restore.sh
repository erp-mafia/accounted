#!/usr/bin/env bash
# Accounted self-host restore: the counterpart of backup.sh.
#
# Restores one backup set (database dump, optional storage archive, optional
# db-config archive) from the S3-compatible bucket into a target Postgres and
# storage directory. Destructive by design: it drops and recreates the
# objects in the target database (--clean). Run it against a FRESH Supabase
# stack, or one you are prepared to overwrite, and pass --yes.
#
# Usage:
#   scripts/self-host/restore.sh <backup-name> --yes
#     e.g. scripts/self-host/restore.sh nightly-20260820T020000Z --yes
#
# Environment:
#   RESTORE_DATABASE_URL     target postgresql://... (required)
#   BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, AWS_ACCESS_KEY_ID,
#   AWS_SECRET_ACCESS_KEY, BACKUP_S3_REGION, BACKUP_S3_PREFIX   as in backup.sh
#   RESTORE_STORAGE_DIR      optional: where to unpack the storage archive
#                            (the new stack's <supabase-dir>/volumes/storage).
#   RESTORE_DB_CONFIG_VOLUME optional: Docker volume name to unpack the
#                            db-config archive into (do this BEFORE the
#                            database container first starts).
#   RESTORE_WORKDIR          optional scratch dir.
#   RESTORE_TOLERATE_ERRORS  optional: set to 1 to continue when pg_restore
#                            reports errors (exit status 1). Default is to
#                            STOP before touching storage and show the error
#                            log: on a Supabase target some "already exists"
#                            errors are routine, but a partial restore must
#                            be a decision you take knowingly, not a default.
#
# Order that works: (1) bring up a fresh Supabase stack with the SAME
# JWT_SECRET / ANON_KEY / SERVICE_ROLE_KEY as the old one (or re-issue keys to
# your Accounted .env), (2) restore db-config, (3) restore the database,
# (4) restore storage, (5) restart storage-api, (6) run
# `scripts/smoke-ai-provider.ts`-style checks and log in.
set -euo pipefail
# Downloaded dumps are the whole ledger: never world-readable.
umask 077

NAME="${1:-}"
CONFIRM="${2:-}"
if [ -z "$NAME" ] || [ "$NAME" = "--help" ]; then
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
if [ "$CONFIRM" != "--yes" ]; then
  echo "restore: refusing to run without --yes (this overwrites the target database)" >&2
  exit 2
fi
# The name becomes S3 keys, local file names and container arguments: only
# the characters backup.sh can produce are accepted, so nothing shell- or
# path-like ever reaches those places.
if ! [[ "$NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "restore: invalid backup name \"$NAME\" (expected e.g. nightly-20260820T020000Z)" >&2
  exit 2
fi

: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"
: "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT is required}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"

export AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-us-east-1}"
PREFIX="${BACKUP_S3_PREFIX:-accounted}"

for bin in pg_restore tar gzip aws; do
  command -v "$bin" >/dev/null 2>&1 || { echo "restore: missing required tool: $bin" >&2; exit 2; }
done
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"; else SHA="shasum -a 256"; fi

WORK="${RESTORE_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/accounted-restore.XXXXXX")}"
mkdir -p "$WORK"
chmod 700 "$WORK"
cleanup() { [ -z "${RESTORE_WORKDIR:-}" ] && rm -rf "$WORK"; }
trap cleanup EXIT

fetch() {
  # fetch <file-name> -> downloads into $WORK, returns 1 when the key is absent
  aws s3api get-object --endpoint-url "$BACKUP_S3_ENDPOINT" --bucket "$BACKUP_S3_BUCKET" \
    --key "${PREFIX}/${NAME}/$1" "${WORK}/$1" >/dev/null 2>&1
}

echo "restore: fetching ${NAME} from s3://${BACKUP_S3_BUCKET}/${PREFIX}/${NAME}/"
fetch "${NAME}.sha256" || { echo "restore: no manifest found for ${NAME}" >&2; exit 1; }
fetch "${NAME}.db.dump" || { echo "restore: database dump missing" >&2; exit 1; }
HAVE_STORAGE=0; fetch "${NAME}.storage.tar.gz" && HAVE_STORAGE=1
HAVE_DBCONFIG=0; fetch "${NAME}.db-config.tar.gz" && HAVE_DBCONFIG=1

# Verify every file the manifest lists before touching anything.
( cd "$WORK" && $SHA -c "${NAME}.sha256" )
echo "restore: checksums verified"

if [ "$HAVE_DBCONFIG" = 1 ] && [ -n "${RESTORE_DB_CONFIG_VOLUME:-}" ]; then
  command -v docker >/dev/null 2>&1 || { echo "restore: RESTORE_DB_CONFIG_VOLUME set but docker not found" >&2; exit 2; }
  # No shell inside the container: tar receives the path as an argument.
  docker run --rm -v "${RESTORE_DB_CONFIG_VOLUME}:/dst" -v "${WORK}:/in:ro" alpine:3 \
    tar -C /dst -xzf "/in/${NAME}.db-config.tar.gz"
  echo "restore: db-config volume restored (${RESTORE_DB_CONFIG_VOLUME})"
fi

# Log only what follows the last "@" (host, port, database): never the
# credentials part of the URL.
echo "restore: restoring database into ${RESTORE_DATABASE_URL##*@} (objects are dropped and recreated)"
# --clean --if-exists: drop objects before recreating them. --no-owner: the
# fresh stack owns its roles. ACLs are restored (no --no-privileges): the
# Supabase roles (anon, authenticated, service_role, postgres) exist under the
# same names in every stack, and the migrations' REVOKE/GRANT hardening of
# SECURITY DEFINER RPCs must survive a restore or a restored self-host would
# re-expose service_role-only functions over PostgREST. pg_restore exits 1 when
# any restore operation failed; that can be a routine "already exists" on a
# Supabase target or a genuinely missing table, and the script cannot tell
# which. Default: stop here, show the log, restore nothing further. The
# operator reads the log and re-runs with RESTORE_TOLERATE_ERRORS=1 if the
# errors are the expected kind.
PG_LOG="${WORK}/pg_restore.log"
set +e
pg_restore --clean --if-exists --no-owner --dbname "$RESTORE_DATABASE_URL" \
  "${WORK}/${NAME}.db.dump" 2> "$PG_LOG"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  echo "restore: pg_restore exited with status ${rc}; errors reported:" >&2
  grep -E "^pg_restore: (error|warning)" "$PG_LOG" | head -40 >&2 || tail -40 "$PG_LOG" >&2
  if [ "$rc" -ne 1 ] || [ "${RESTORE_TOLERATE_ERRORS:-0}" != "1" ]; then
    echo "restore: stopping before storage. Inspect the errors above; if they are the expected \"already exists\" kind on a Supabase target, re-run with RESTORE_TOLERATE_ERRORS=1." >&2
    exit "$rc"
  fi
  echo "restore: continuing despite pg_restore errors (RESTORE_TOLERATE_ERRORS=1)" >&2
fi
echo "restore: database restored (pg_restore status ${rc})"

if [ "$HAVE_STORAGE" = 1 ] && [ -n "${RESTORE_STORAGE_DIR:-}" ]; then
  mkdir -p "$RESTORE_STORAGE_DIR"
  tar -C "$RESTORE_STORAGE_DIR" -xzf "${WORK}/${NAME}.storage.tar.gz"
  echo "restore: storage unpacked into ${RESTORE_STORAGE_DIR} (restart storage-api)"
elif [ "$HAVE_STORAGE" = 1 ]; then
  echo "restore: storage archive present but RESTORE_STORAGE_DIR unset; skipped"
fi

echo "restore: done ${NAME}"
