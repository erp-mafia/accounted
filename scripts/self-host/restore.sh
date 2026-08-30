#!/usr/bin/env bash
# Accounted self-host restore: the counterpart of backup.sh.
#
# Restores one backup set (database dump, ACL manifest, optional storage
# archive, optional db-config archive) from the S3-compatible bucket into a
# target Postgres and storage directory. Destructive by design: it drops and
# recreates the objects in the target database (--clean). Run it against a
# FRESH Supabase stack, or one you are prepared to overwrite, and pass --yes.
#
# Usage:
#   scripts/self-host/restore.sh <backup-name> --yes
#     e.g. scripts/self-host/restore.sh nightly-20260820T020000Z --yes
#
# Environment:
#   RESTORE_DATABASE_URL     target postgresql://... (required unless
#                            RESTORE_SKIP_DATABASE=1). Connect as the stack's
#                            `postgres` role, the one the migrations ran as.
#   BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, AWS_ACCESS_KEY_ID,
#   AWS_SECRET_ACCESS_KEY, BACKUP_S3_REGION, BACKUP_S3_PREFIX   as in backup.sh
#   RESTORE_STORAGE_DIR      optional: where to unpack the storage archive
#                            (the new stack's <supabase-dir>/volumes/storage).
#   RESTORE_DB_CONFIG_VOLUME optional: Docker volume name to unpack the
#                            db-config archive into. The database container
#                            must be STOPPED for this and started afterwards,
#                            so do it as its own pass with
#                            RESTORE_SKIP_DATABASE=1 (see the runbook).
#   RESTORE_SKIP_DATABASE    optional: set to 1 to skip pg_restore and the ACL
#                            check (the db-config pass above).
#   RESTORE_WORKDIR          optional scratch dir.
#   RESTORE_TOLERATE_ERRORS  optional: set to 1 to continue when pg_restore
#                            reports errors (exit status 1). Default is to
#                            STOP before the ACL check and storage and show
#                            the error log. On a Supabase target these
#                            classes are routine (the stack already owns and
#                            grants those objects; the restoring role is not a
#                            superuser): "already exists"; "does not exist"
#                            from DROP ... IF EXISTS of policies/triggers on
#                            a fresh target; "must be member of role
#                            supabase_*", "must be owner of ...", "permission
#                            denied ..." and "grant options cannot be granted
#                            back" on GRANT/REVOKE/ALTER for objects in
#                            auth, storage, realtime, extensions, cron, vault,
#                            graphql*, pgbouncer. Errors on public.* objects
#                            are NOT expected: investigate before continuing.
#                            A partial restore must be a decision you take
#                            knowingly, not a default.
#
# Order that works: (1) bring up a fresh Supabase stack with the SAME
# JWT_SECRET / ANON_KEY / SERVICE_ROLE_KEY as the old one (or re-issue keys to
# your Accounted .env), (2) stop the database container and restore db-config
# (RESTORE_DB_CONFIG_VOLUME + RESTORE_SKIP_DATABASE=1), (3) start it and
# restore the database and storage (second run), (4) restart storage-api,
# (5) run `scripts/smoke-ai-provider.ts`-style checks and log in.
set -euo pipefail
# Downloaded dumps are the whole ledger: never world-readable.
umask 077

NAME="${1:-}"
CONFIRM="${2:-}"
if [ -z "$NAME" ] || [ "$NAME" = "--help" ]; then
  sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
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

SKIP_DB="${RESTORE_SKIP_DATABASE:-0}"
if [ "$SKIP_DB" != "1" ]; then
  : "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required (or set RESTORE_SKIP_DATABASE=1)}"
fi
: "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT is required}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"

export AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-us-east-1}"
PREFIX="${BACKUP_S3_PREFIX:-accounted}"

for bin in pg_restore psql tar gzip aws; do
  command -v "$bin" >/dev/null 2>&1 || { echo "restore: missing required tool: $bin" >&2; exit 2; }
done
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"; else SHA="shasum -a 256"; fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
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
HAVE_ACL=0; fetch "${NAME}.acl.txt" && HAVE_ACL=1
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
  echo "restore: db-config volume restored (${RESTORE_DB_CONFIG_VOLUME}); start the database container before the database pass"
fi

if [ "$SKIP_DB" = "1" ]; then
  echo "restore: RESTORE_SKIP_DATABASE=1, database not touched"
else
  # Log only what follows the last "@" (host, port, database): never the
  # credentials part of the URL.
  echo "restore: restoring database into ${RESTORE_DATABASE_URL##*@} (objects are dropped and recreated)"

  # The dump carries ACLs, but pg_dump writes them as a diff against
  # PostgreSQL's built-in defaults (acldefault), never against the target's
  # ALTER DEFAULT PRIVILEGES. A Supabase stack grants anon, authenticated and
  # service_role on every new function/table/sequence the postgres role
  # creates, so restoring into it would hand anon/authenticated EXECUTE back
  # to every hardened RPC: the dump only says "REVOKE FROM PUBLIC; GRANT TO
  # service_role" and never "REVOKE FROM anon". Put the restoring role's
  # default privileges back to exactly PostgreSQL's built-in defaults right
  # before pg_restore (revoke every added grantee; PUBLIC back to EXECUTE on
  # functions and USAGE on types, nothing on tables and sequences), so the
  # dump's explicit GRANT/REVOKE statements apply to the base they were
  # computed against. The dump's own last section (DEFAULT ACL) re-creates
  # the stack's default privileges once every object exists, so migrations
  # applied later still get the grants PostgREST needs; the check after
  # pg_restore confirms that.
  psql -X -q -v ON_ERROR_STOP=1 "$RESTORE_DATABASE_URL" <<'SQL'
DO $$
DECLARE
  r record;
  scope text;
  kind text;
BEGIN
  -- 1. Every grantee the stack added to the defaults (anon, authenticated,
  --    service_role, PUBLIC on tables, ...): revoke it. The role's own
  --    privileges are left alone. IN SCHEMA entries are additions on top of
  --    the built-in default and PostgreSQL drops them once they are empty.
  FOR r IN
    SELECT DISTINCT d.defaclobjtype AS objtype, d.defaclnamespace AS nsp, a.grantee
    FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND d.defaclnamespace IN (0, 'public'::regnamespace)
      AND a.grantee <> d.defaclrole
  LOOP
    scope := CASE WHEN r.nsp = 0 THEN '' ELSE 'IN SCHEMA public' END;
    kind := CASE r.objtype
      WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS'
      WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS'
    END;
    EXECUTE format('ALTER DEFAULT PRIVILEGES %s REVOKE ALL ON %s FROM %s', scope, kind,
      CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE r.grantee::regrole::text END);
  END LOOP;
  -- 2. A global entry (no schema) REPLACES the built-in default, so one that
  --    took EXECUTE on functions or USAGE on types away from PUBLIC would
  --    still be in force. Grant those back: an entry equal to the built-in
  --    default is removed by PostgreSQL itself. (The Supabase image has no
  --    global entries for postgres; an operator-hardened stack may.)
  FOR r IN
    SELECT DISTINCT d.defaclobjtype AS objtype
    FROM pg_default_acl d
    WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND d.defaclnamespace = 0
      AND d.defaclobjtype IN ('f', 'T')
  LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES GRANT %s ON %s TO PUBLIC',
      CASE WHEN r.objtype = 'f' THEN 'EXECUTE' ELSE 'USAGE' END,
      CASE WHEN r.objtype = 'f' THEN 'FUNCTIONS' ELSE 'TYPES' END);
  END LOOP;
END $$;
SQL
  echo "restore: default privileges of the restoring role neutralized for the restore"

  # --clean --if-exists: drop objects before recreating them. --no-owner: the
  # fresh stack owns its roles. No --no-privileges: the ACLs are the point.
  # pg_restore exits 1 when any restore operation failed; on a Supabase
  # target the classes listed in the header are routine (stack-owned objects
  # the non-superuser postgres role may not drop or re-grant), a missing
  # table or an error on a public.* object is not, and the script cannot
  # tell which. Default: stop here, show the log, restore nothing further.
  # The operator reads the log and re-runs with RESTORE_TOLERATE_ERRORS=1 if
  # the errors are the expected kind.
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
      echo "restore: stopping before the ACL check and storage (the db-config volume, if requested, is already unpacked). Inspect the errors above; if they are the expected kind on a Supabase target (\"already exists\", \"does not exist\" from DROP IF EXISTS, and permission/ownership/grant errors on objects in auth, storage, realtime, extensions, cron, vault, graphql*, pgbouncer, never on public.*), re-run with RESTORE_TOLERATE_ERRORS=1." >&2
      exit "$rc"
    fi
    echo "restore: continuing despite pg_restore errors (RESTORE_TOLERATE_ERRORS=1)" >&2
  fi
  echo "restore: database restored (pg_restore status ${rc})"

  # ACL check: the manifest backup.sh took from the source must match the
  # restored database line for line. A difference means an object is now
  # reachable by a PostgREST role that could not reach it before (or the
  # reverse), and there is no override: fix the ACLs by hand from the diff
  # (GRANT/REVOKE on the named objects) or re-run into a fresh stack.
  if [ "$HAVE_ACL" = 1 ]; then
    ACL_NOW="${WORK}/${NAME}.acl.restored.txt"
    psql -X -A -t -q -v ON_ERROR_STOP=1 -f "${SCRIPT_DIR}/acl-manifest.sql" "$RESTORE_DATABASE_URL" > "$ACL_NOW"
    if ! diff -u "${WORK}/${NAME}.acl.txt" "$ACL_NOW" > "${WORK}/acl.diff"; then
      echo "restore: ACL MISMATCH between the source manifest (-) and the restored database (+):" >&2
      grep -E "^[-+](function|relation|sequence) " "${WORK}/acl.diff" | head -60 >&2
      echo "restore: stopping before storage. The restored database does not grant the PostgREST roles what the source did; see the lines above." >&2
      exit 1
    fi
    echo "restore: ACL manifest verified ($(wc -l < "$ACL_NOW" | tr -d ' ') objects, identical to the source)"
  else
    echo "restore: no ACL manifest in this set (older backup.sh); ACL verification skipped" >&2
  fi

  # The dump's DEFAULT ACL section should have re-created the stack's default
  # privileges for the restoring role. If it did not (restored as a role the
  # source never set defaults for), later migrations would create objects the
  # PostgREST roles cannot reach: say so.
  DEFACL_ROWS="$(psql -X -A -t -q -v ON_ERROR_STOP=1 "$RESTORE_DATABASE_URL" \
    -c "select count(*) from pg_default_acl where defaclrole = (select oid from pg_roles where rolname = current_user) and defaclnamespace = 'public'::regnamespace")"
  if [ "${DEFACL_ROWS:-0}" = "0" ]; then
    echo "restore: WARNING: no default privileges for the restoring role in schema public after the restore; re-apply the stack's ALTER DEFAULT PRIVILEGES (tables, functions, sequences to anon, authenticated, service_role) before running further migrations" >&2
  fi
fi

if [ "$HAVE_STORAGE" = 1 ] && [ -n "${RESTORE_STORAGE_DIR:-}" ]; then
  mkdir -p "$RESTORE_STORAGE_DIR"
  tar -C "$RESTORE_STORAGE_DIR" -xzf "${WORK}/${NAME}.storage.tar.gz"
  echo "restore: storage unpacked into ${RESTORE_STORAGE_DIR} (restart storage-api)"
elif [ "$HAVE_STORAGE" = 1 ]; then
  echo "restore: storage archive present but RESTORE_STORAGE_DIR unset; skipped"
fi

echo "restore: done ${NAME}"
