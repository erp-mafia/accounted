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
#
# Order that works: (1) bring up a fresh Supabase stack with the SAME
# JWT_SECRET / ANON_KEY / SERVICE_ROLE_KEY as the old one (or re-issue keys to
# your Accounted .env), (2) restore db-config, (3) restore the database,
# (4) restore storage, (5) restart storage-api, (6) run
# `scripts/smoke-ai-provider.ts`-style checks and log in.
set -euo pipefail

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
  docker run --rm -v "${RESTORE_DB_CONFIG_VOLUME}:/dst" -v "${WORK}:/in:ro" alpine:3 \
    sh -c "tar -C /dst -xzf /in/${NAME}.db-config.tar.gz"
  echo "restore: db-config volume restored (${RESTORE_DB_CONFIG_VOLUME})"
fi

echo "restore: restoring database into ${RESTORE_DATABASE_URL%%@*}@... (objects are dropped and recreated)"
# --clean --if-exists: drop objects before recreating them. --no-owner /
# --no-privileges: the fresh stack owns its roles. Exit status 1 from
# pg_restore means "errors occurred" (typically harmless "does not exist" on
# a clean target); anything else is fatal.
set +e
pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$RESTORE_DATABASE_URL" "${WORK}/${NAME}.db.dump"
rc=$?
set -e
if [ "$rc" -gt 1 ]; then
  echo "restore: pg_restore failed with status ${rc}" >&2
  exit "$rc"
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
