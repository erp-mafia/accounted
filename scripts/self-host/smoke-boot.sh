#!/usr/bin/env bash
# Boot smoke test for the self-host image under the shipped docker-compose.yml.
#
# Starts the app service the way an operator's `docker compose up -d` does:
# same compose file, so the same read-only root, `cap_drop: ALL`, mem_limit,
# pids_limit and writable mounts. Only the image reference is swapped in and
# the environment is dummy (no database is reachable). It fails unless the
# entrypoint completes and Next.js reports Ready, first on a fresh volume and
# then again after a restart: the restart re-runs the entrypoint over the
# previous start's write-protected copy in the volume, which is the path every
# restart and every image upgrade takes.
#
# #3164 shipped because nothing booted the image under these limits before
# `latest` moved: the bundle outgrew the 400 MB tmpfs /app/.next used to be,
# and every install restart-looped on "No space left on device".
# docker-publish.yml runs this per platform before tagging.
#
# Usage: scripts/self-host/smoke-boot.sh <image-ref>
#   e.g. ghcr.io/erp-mafia/gnubok@sha256:<digest> or ghcr.io/erp-mafia/gnubok:<sha>
# Requires docker with the compose plugin, and curl. Pulls the image if it is
# not present locally.
#
# Environment (optional):
#   SMOKE_TIMEOUT  seconds to wait for each start to report Ready (default 180)
#   SMOKE_PORT     host loopback port for the app (default 3000, as in the
#                  compose file)
set -euo pipefail

IMAGE="${1:?usage: smoke-boot.sh <image-ref>}"
TIMEOUT="${SMOKE_TIMEOUT:-180}"
PORT="${SMOKE_PORT:-3000}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT="accounted-smoke-$$"

# A private project directory: the compose file reads `.env` next to itself,
# and an operator's real .env in the checkout must never be touched.
WORK="$(mktemp -d)"
cp "$REPO_ROOT/docker-compose.yml" "$WORK/docker-compose.yml"
cat > "$WORK/smoke.override.yml" <<EOF
services:
  app:
    image: ${IMAGE}
EOF
# Dummy values that pass the entrypoint's required-variable check. Nothing
# listens at the Supabase URL, so /api/health answers "unhealthy", which is
# still a response from a route the server loaded out of the volume.
cat > "$WORK/.env" <<'EOF'
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=smoke-anon-key
SUPABASE_SERVICE_ROLE_KEY=smoke-service-role-key
NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000
CRON_SECRET=smoke-cron-secret-not-used-anywhere
NEXT_PUBLIC_SELF_HOSTED=true
EOF

compose() {
  PORT="$PORT" docker compose --project-name "$PROJECT" --project-directory "$WORK" \
    -f "$WORK/docker-compose.yml" -f "$WORK/smoke.override.yml" "$@"
}

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "::error::smoke-boot: $*" >&2
  compose logs --no-color --tail 60 app >&2 || true
  exit 1
}

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker pull --quiet "$IMAGE" >/dev/null
fi

# Waits until the app container has logged Ready $1 times (once per start),
# failing early if the container exits or the restart policy restarts it.
wait_ready() {
  local want="$1" cid state restarts ready waited=0
  cid="$(compose ps --all --quiet app)"
  [ -n "$cid" ] || fail "no app container was created"
  while :; do
    state="$(docker inspect --format '{{.State.Status}}' "$cid")"
    restarts="$(docker inspect --format '{{.RestartCount}}' "$cid")"
    ready="$(docker logs "$cid" 2>&1 | grep -c 'Ready in' || true)"
    if [ "$ready" -ge "$want" ] && [ "$state" = "running" ]; then
      echo "smoke-boot: start ${want} reported Ready after ${waited}s"
      return 0
    fi
    [ "$restarts" -eq 0 ] || fail "the entrypoint or server exited and the restart policy restarted it (start ${want})"
    case "$state" in
      created|running) ;;
      *) fail "the app container is ${state} (start ${want})" ;;
    esac
    [ "$waited" -lt "$TIMEOUT" ] || fail "start ${want} did not report Ready within ${TIMEOUT}s"
    sleep 2
    waited=$((waited + 2))
  done
}

# A response from a route handler proves the server can load its chunks from
# the volume. Any status is fine here (503 without a database); what matters
# is the health route's JSON body.
check_health_route() {
  local body
  body="$(curl --silent --max-time 20 "http://127.0.0.1:${PORT}/api/health" || true)"
  case "$body" in
    *'"status"'*) echo "smoke-boot: /api/health answered: ${body}" ;;
    *) fail "/api/health did not answer from the server (got: ${body:-no response})" ;;
  esac
}

# The entrypoint's job on every start: the served copy carries the runtime
# values, not the build's placeholders.
check_substituted() {
  local left
  left="$(compose exec -T app sh -c \
    "grep -rl '__NEXT_PUBLIC_SUPABASE_URL__' /app/.next /app/public 2>/dev/null | head -5" || true)"
  [ -z "$left" ] || fail "placeholders were not substituted in: ${left}"
  echo "smoke-boot: NEXT_PUBLIC_* placeholders substituted"
}

# The writable mounts stay readable by the nodejs group only (mode 750), as the
# compose file promises, whatever image first created the volume.
check_mount_modes() {
  local modes
  modes="$(compose exec -T app stat -c '%a' /app/.next /app/public | tr '\n' ' ' || true)"
  [ "$modes" = "750 750 " ] || fail "/app/.next and /app/public should be mode 750, got: ${modes:-nothing}"
  echo "smoke-boot: /app/.next and /app/public are mode 750"
}

compose up --detach --pull never app
wait_ready 1
check_health_route
check_substituted
check_mount_modes

compose restart app
wait_ready 2
check_health_route
check_substituted
check_mount_modes

docker stats --no-stream --format 'smoke-boot: memory {{.MemUsage}}' \
  "$(compose ps --quiet app)" || true
echo "smoke-boot: OK, ${IMAGE} boots and restarts under docker-compose.yml"
