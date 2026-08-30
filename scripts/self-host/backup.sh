#!/usr/bin/env bash
# Accounted self-host backup: logical database dump + document storage, shipped
# to an S3-compatible bucket, optionally under S3 Object Lock (WORM).
#
# Self-hosted Supabase has no managed backups or PITR, and Swedish bookkeeping
# law (BFL 7 kap) requires the ledger and its underlag (receipts, invoices) to
# be kept for seven years after the end of the fiscal year. This script is the
# minimum that satisfies both: one restorable dump per run, and the documents
# bucket alongside it, on storage the operator controls. See
# docs/SOVEREIGN.md ("Backup and restore") for the runbook and the cron line.
#
# Requirements on the host running it: bash, pg_dump and psql (matching the
# server's major version), tar, gzip, sha256sum (or shasum), AWS CLI v2 (works
# against any S3-compatible endpoint: Safespring, GleSYS, Elastx via
# --endpoint-url).
#
# Environment (required unless marked optional):
#   BACKUP_DATABASE_URL      postgresql://postgres:<password>@<host>:<port>/postgres
#                            Use the Supabase session-mode pooler port or the
#                            db container's port; never a public address.
#   BACKUP_S3_ENDPOINT       e.g. https://s3.sto2.safedc.net
#   BACKUP_S3_BUCKET         bucket name (create it with Object Lock enabled:
#                            Object Lock can only be turned on at creation)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   credentials for that bucket
#   BACKUP_S3_REGION         optional, default us-east-1 (what most S3-compatible
#                            endpoints expect for SigV4; Elastx requires it)
#   BACKUP_S3_PREFIX         optional, default "accounted"
#   BACKUP_STORAGE_DIR       optional: path of the Supabase storage volume
#                            (STORAGE_BACKEND=file: <supabase-dir>/volumes/storage).
#                            Omit when storage-api writes straight to S3; then
#                            back that bucket up bucket-to-bucket instead.
#   BACKUP_DB_CONFIG_VOLUME  optional: name of the Supabase `db-config` Docker
#                            volume (e.g. supabase_db-config). It holds the
#                            pgsodium root key; a dump restored without it
#                            cannot decrypt Vault secrets. Requires docker.
#   BACKUP_OBJECT_LOCK_DAYS  optional: when set, every uploaded object gets
#                            COMPLIANCE-mode retention for this many days
#                            (immutable even for the bucket owner). Suggested:
#                            a long value (>= 2600, seven years plus margin)
#                            for the yearly post-bokslut run, a short one for
#                            nightly runs, or unset and rely on bucket default
#                            retention. COMPLIANCE retention cannot be shortened.
#   BACKUP_WORKDIR           optional: scratch directory, default mktemp.
#   BACKUP_LABEL             optional: name fragment, default "nightly".
#   BACKUP_QUIESCE_CMD       optional: a command run BEFORE the dump and
#   BACKUP_RESUME_CMD          AFTER the upload (also on failure), e.g.
#                            "docker compose -f /opt/accounted/docker-compose.yml stop app cron"
#                            and the matching "start". The database dump and
#                            the storage tar are taken one after the other;
#                            an upload landing between them leaves a document
#                            row without its file (or the reverse) in that
#                            set. Stopping the app for the window makes the
#                            set consistent; recommended for the yearly
#                            archive run, optional for nightly runs where the
#                            next night's set covers the gap.
#
# Prints a short progress log on stdout; exit status is non-zero on any
# failure, which is what a cron wrapper should alert on.
set -euo pipefail
# Dumps, archives and manifests are the whole ledger: never world-readable,
# whatever the operator's default umask is.
umask 077

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required}"
: "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT is required}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"

export AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-us-east-1}"
PREFIX="${BACKUP_S3_PREFIX:-accounted}"
LABEL="${BACKUP_LABEL:-nightly}"
# The label becomes S3 keys, file names and container arguments: keep it to
# the same character set restore.sh accepts.
if ! [[ "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "backup: invalid BACKUP_LABEL \"$LABEL\" (letters, digits, . _ - only)" >&2
  exit 2
fi
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="${LABEL}-${STAMP}"

for bin in pg_dump psql tar gzip aws; do
  command -v "$bin" >/dev/null 2>&1 || { echo "backup: missing required tool: $bin" >&2; exit 2; }
done
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"; else SHA="shasum -a 256"; fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="${BACKUP_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/accounted-backup.XXXXXX")}"
mkdir -p "$WORK"
chmod 700 "$WORK"
QUIESCED=0
cleanup() {
  if [ "$QUIESCED" = 1 ] && [ -n "${BACKUP_RESUME_CMD:-}" ]; then
    bash -c "$BACKUP_RESUME_CMD" || echo "backup: BACKUP_RESUME_CMD failed; check that the app is running" >&2
  fi
  [ -z "${BACKUP_WORKDIR:-}" ] && rm -rf "$WORK"
}
trap cleanup EXIT

upload() {
  # upload <local-file> <key>
  local file="$1" key="$2"
  local args=(s3api put-object --endpoint-url "$BACKUP_S3_ENDPOINT" --bucket "$BACKUP_S3_BUCKET" --key "$key" --body "$file")
  if [ -n "${BACKUP_OBJECT_LOCK_DAYS:-}" ]; then
    local until
    # GNU date and BSD date differ; try GNU first.
    until="$(date -u -d "+${BACKUP_OBJECT_LOCK_DAYS} days" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+"${BACKUP_OBJECT_LOCK_DAYS}"d +%Y-%m-%dT%H:%M:%SZ)"
    args+=(--object-lock-mode COMPLIANCE --object-lock-retain-until-date "$until")
  fi
  aws "${args[@]}" >/dev/null
  echo "backup: uploaded s3://${BACKUP_S3_BUCKET}/${key}"
}

echo "backup: starting ${NAME}"

if [ -n "${BACKUP_QUIESCE_CMD:-}" ]; then
  bash -c "$BACKUP_QUIESCE_CMD"
  QUIESCED=1
  echo "backup: application quiesced for a consistent set"
fi

# 1. Database: custom-format dump (compressed, selective restore possible).
#    --no-owner so it restores into a fresh Supabase stack whose roles were
#    created by that stack, not by us. ACLs (GRANT/REVOKE) are kept (no
#    --no-privileges): the migrations lock SECURITY DEFINER RPCs away from
#    anon/authenticated, and the dump is the only record of that. Keeping them
#    is necessary but not sufficient: pg_dump writes ACLs as a diff against
#    PostgreSQL's built-in defaults, so a role-specific "REVOKE ... FROM anon"
#    is not in the dump at all, and a Supabase target's ALTER DEFAULT
#    PRIVILEGES would hand anon/authenticated EXECUTE back to every restored
#    function. restore.sh neutralizes those default privileges before
#    pg_restore and then diffs the ACL manifest taken in step 1b against the
#    restored database, so a re-exposure fails the restore instead of hiding.
DB_FILE="${WORK}/${NAME}.db.dump"
pg_dump --format=custom --no-owner --file "$DB_FILE" "$BACKUP_DATABASE_URL"
echo "backup: database dump $(du -h "$DB_FILE" | cut -f1)"

# 1b. ACL manifest: what anon/authenticated/service_role may do with every
#     function and relation in public (scripts/self-host/acl-manifest.sql).
#     restore.sh compares the restored database against this file.
ACL_FILE="${WORK}/${NAME}.acl.txt"
psql -X -A -t -q -v ON_ERROR_STOP=1 -f "${SCRIPT_DIR}/acl-manifest.sql" "$BACKUP_DATABASE_URL" > "$ACL_FILE"
echo "backup: ACL manifest $(wc -l < "$ACL_FILE" | tr -d ' ') objects"

# 2. Documents (the BFL underlag) when storage-api uses the file backend.
STORAGE_FILE=""
if [ -n "${BACKUP_STORAGE_DIR:-}" ]; then
  if [ ! -d "$BACKUP_STORAGE_DIR" ]; then
    echo "backup: BACKUP_STORAGE_DIR does not exist: $BACKUP_STORAGE_DIR" >&2
    exit 2
  fi
  STORAGE_FILE="${WORK}/${NAME}.storage.tar.gz"
  tar -C "$BACKUP_STORAGE_DIR" -czf "$STORAGE_FILE" .
  echo "backup: storage archive $(du -h "$STORAGE_FILE" | cut -f1)"
fi

# 3. Supabase db-config volume (pgsodium root key), optional but strongly
#    recommended: without it Vault-encrypted columns in the dump are
#    unreadable after a restore.
DBCONFIG_FILE=""
if [ -n "${BACKUP_DB_CONFIG_VOLUME:-}" ]; then
  command -v docker >/dev/null 2>&1 || { echo "backup: BACKUP_DB_CONFIG_VOLUME set but docker not found" >&2; exit 2; }
  DBCONFIG_FILE="${WORK}/${NAME}.db-config.tar.gz"
  docker run --rm -v "${BACKUP_DB_CONFIG_VOLUME}:/src:ro" -v "${WORK}:/out" alpine:3 \
    tar -C /src -czf "/out/$(basename "$DBCONFIG_FILE")" .
  echo "backup: db-config archive $(du -h "$DBCONFIG_FILE" | cut -f1)"
fi

# 4. Checksums, then upload everything under one prefix.
MANIFEST="${WORK}/${NAME}.sha256"
( cd "$WORK" && $SHA "$(basename "$DB_FILE")" "$(basename "$ACL_FILE")" \
    ${STORAGE_FILE:+"$(basename "$STORAGE_FILE")"} \
    ${DBCONFIG_FILE:+"$(basename "$DBCONFIG_FILE")"} > "$MANIFEST" )

for f in "$DB_FILE" "$ACL_FILE" ${STORAGE_FILE:+"$STORAGE_FILE"} ${DBCONFIG_FILE:+"$DBCONFIG_FILE"} "$MANIFEST"; do
  upload "$f" "${PREFIX}/${NAME}/$(basename "$f")"
done

echo "backup: done ${NAME}"
