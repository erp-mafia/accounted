#!/bin/sh
set -e

# ─── Validate required environment variables ───
missing=""
for var in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_APP_URL CRON_SECRET; do
  eval val=\$$var
  if [ -z "$val" ]; then
    missing="$missing  - $var\n"
  fi
done

if [ -n "$missing" ]; then
  printf "ERROR: Missing required environment variables:\n%b\nSee docker/.env.example for reference.\n" "$missing" >&2
  exit 1
fi

# Warn if placeholder values are still set
placeholders_found=""
case "$NEXT_PUBLIC_SUPABASE_ANON_KEY" in *your-anon-key*) placeholders_found="$placeholders_found  - NEXT_PUBLIC_SUPABASE_ANON_KEY\n" ;; esac
case "$SUPABASE_SERVICE_ROLE_KEY" in *your-service-role-key*) placeholders_found="$placeholders_found  - SUPABASE_SERVICE_ROLE_KEY\n" ;; esac
case "$NEXT_PUBLIC_SUPABASE_URL" in *your-project*) placeholders_found="$placeholders_found  - NEXT_PUBLIC_SUPABASE_URL\n" ;; esac
case "$NEXT_PUBLIC_APP_URL" in *your-domain*) placeholders_found="$placeholders_found  - NEXT_PUBLIC_APP_URL\n" ;; esac
case "$CRON_SECRET" in *generate-a-random-secret*) placeholders_found="$placeholders_found  - CRON_SECRET\n" ;; esac

if [ -n "$placeholders_found" ]; then
  printf "WARNING: These variables appear to contain placeholder values:\n%bPlease set them to real values before running in production.\n" "$placeholders_found" >&2
fi

# ─── Populate the writable mounts from the baked-in templates ───
# Under docker-compose's `read_only: true`, /app/.next is a named volume and
# /app/public a tmpfs, both owned by nextjs (uid=1001); this cp fills them at
# every startup. /app/server.js, /app/node_modules and /app/package.json stay on
# the read-only image layer. Running as the unprivileged nextjs user means no
# CAP_CHOWN / CAP_SETUID is needed, so the container works under `cap_drop: ALL`.
# Without read_only:true the mount points were created empty in the Dockerfile,
# so the same cp still works.
#
# The volume outlives the container, so it still holds the previous start's
# copy, possibly from an older image. Both targets are emptied first, so every
# start serves exactly this image's bundle, as a fresh tmpfs did, and upgrades
# do not pile stale chunks onto the disk. That copy had its write bits removed
# (see the immutability step below), so owner-write is restored first:
# otherwise the unprivileged delete fails under `set -e`.
chmod -R u+w /app/.next /app/public 2>/dev/null || true
find /app/.next /app/public -mindepth 1 -delete
# Docker copies the image directory's mode into a named volume only when it
# creates the volume, so a volume first created by an older image (whose
# /app/.next was 755) would keep that mode forever. The owner can chmod its own
# mount root without any capability, so every start converges on 750: readable
# by the nodejs group only, like the uid=1001,mode=750 tmpfs it replaced.
chmod 750 /app/.next /app/public 2>/dev/null || true
if [ -d /opt/gnubok-template/.next ]; then
  # One readable error instead of a cp write error per file, looped by the
  # restart policy, when the target cannot hold the bundle. The usual cause is
  # a docker-compose.yml from before #3164 that still mounts /app/.next as a
  # size-capped tmpfs: `docker compose pull` updates the image, not that file.
  need_kb=$(du -sk /opt/gnubok-template/.next | cut -f1)
  free_kb=$(df -Pk /app/.next | awk 'NR == 2 { print $4 }')
  if [ -n "$free_kb" ] && [ "$need_kb" -gt "$free_kb" ]; then
    printf "ERROR: /app/.next has %s MB free, but this image's app bundle needs %s MB.\n" \
      "$((free_kb / 1024))" "$((need_kb / 1024))" >&2
    printf "If your docker-compose.yml still mounts /app/.next as a tmpfs, replace that\n" >&2
    printf "mount with the next_runtime volume from the current docker-compose.yml in\n" >&2
    printf "the repository (docker compose pull updates the image, not that file).\n" >&2
    printf "Otherwise, free up disk space on the Docker host.\n" >&2
    exit 1
  fi
  cp -R /opt/gnubok-template/.next/. /app/.next/
fi
if [ -d /opt/gnubok-template/public ]; then
  cp -R /opt/gnubok-template/public/. /app/public/
fi
mkdir -p /app/.next/cache

# ─── Replace build-time placeholder sentinels with runtime env vars ───
# Substitution covers /app/.next (client static + server bundles + manifests;
# the manifests at .next/ root hold the CSP/headers from next.config.ts) and
# /app/public (sw.js: the service worker is served raw, so Next's build-time
# inlining doesn't reach it). server.js needs no substitution and lives on the
# read-only image layer, so it is deliberately excluded.
#
# `sed -i` rewrites every file it touches, so we prefilter with `grep -l` and
# only sed files that actually contain a placeholder. busybox grep has no -Z,
# so we rely on Next.js build outputs not having newlines in filenames.
SUBST_PATHS=""
[ -d /app/.next ]  && SUBST_PATHS="$SUBST_PATHS /app/.next"
[ -d /app/public ] && SUBST_PATHS="$SUBST_PATHS /app/public"

if [ -n "$SUBST_PATHS" ]; then
  # Escape sed replacement metacharacters (backslash, & whole-match, and the |
  # delimiter) so a value like "Acme & Co." (legal in NEXT_PUBLIC_BRANDING_APP_NAME)
  # or one containing | can't corrupt the output or break the sed command.
  # busybox-ash-compatible parameter expansion (verified on busybox 1.37).
  sed_esc() {
    v=$1
    v=${v//\\/\\\\}
    v=${v//&/\\&}
    v=${v//|/\\|}
    printf %s "$v"
  }
  # Realtime WebSocket origin for the CSP (issue #893): derive from the
  # Supabase URL unless explicitly overridden. https:// becomes wss://;
  # http:// becomes ws:// for plain-HTTP local installs. Without this token
  # in connect-src, Supabase Realtime's WebSocket is CSP-blocked on
  # self-hosted installs and WebKit crashes the dashboard.
  if [ -z "${NEXT_PUBLIC_SUPABASE_WS_URL:-}" ]; then
    NEXT_PUBLIC_SUPABASE_WS_URL=$(printf %s "$NEXT_PUBLIC_SUPABASE_URL" \
      | sed -e 's|^https://|wss://|' -e 's|^http://|ws://|')
  fi

  E_SUPABASE_URL=$(sed_esc "$NEXT_PUBLIC_SUPABASE_URL")
  E_SUPABASE_WS_URL=$(sed_esc "$NEXT_PUBLIC_SUPABASE_WS_URL")
  E_SUPABASE_ANON_KEY=$(sed_esc "$NEXT_PUBLIC_SUPABASE_ANON_KEY")
  E_APP_URL=$(sed_esc "$NEXT_PUBLIC_APP_URL")
  E_VAPID_PUBLIC_KEY=$(sed_esc "${NEXT_PUBLIC_VAPID_PUBLIC_KEY:-}")
  E_SELF_HOSTED=$(sed_esc "${NEXT_PUBLIC_SELF_HOSTED:-true}")
  E_REQUIRE_MFA=$(sed_esc "${NEXT_PUBLIC_REQUIRE_MFA:-false}")
  E_SESSION_IDLE_TIMEOUT_MS=$(sed_esc "${NEXT_PUBLIC_SESSION_IDLE_TIMEOUT_MS:-}")
  E_SESSION_ABSOLUTE_TIMEOUT_MS=$(sed_esc "${NEXT_PUBLIC_SESSION_ABSOLUTE_TIMEOUT_MS:-}")
  E_SESSION_WARNING_MS=$(sed_esc "${NEXT_PUBLIC_SESSION_WARNING_MS:-}")
  E_SESSION_TIMEOUT_FORCE_ALL=$(sed_esc "${NEXT_PUBLIC_SESSION_TIMEOUT_FORCE_ALL:-}")
  E_TURNSTILE_SITE_KEY=$(sed_esc "${NEXT_PUBLIC_TURNSTILE_SITE_KEY:-}")
  E_BRANDING_APP_NAME=$(sed_esc "${NEXT_PUBLIC_BRANDING_APP_NAME:-Gnubok}")

  # File-type coverage:
  #   *.js: client + server bundles
  #   *.json: routes-manifest.json (CSP/headers), build-manifest.json, etc.
  #   *.html: prerendered pages (e.g. /login title contains BRANDING_APP_NAME)
  #   *.rsc: RSC payloads with the same inlined values
  #   *.body: metadata-route bodies, e.g. manifest.webmanifest.body (PWA name)
  # shellcheck disable=SC2086
  find $SUBST_PATHS -type f \
        \( -name '*.js' -o -name '*.json' -o -name '*.html' -o -name '*.rsc' -o -name '*.body' \) \
        -exec grep -l "__NEXT_PUBLIC_" {} + 2>/dev/null \
    | tr '\n' '\0' \
    | xargs -0 -r sed -i \
        -e "s|__NEXT_PUBLIC_SUPABASE_URL__|${E_SUPABASE_URL}|g" \
        -e "s|__NEXT_PUBLIC_SUPABASE_WS_URL__|${E_SUPABASE_WS_URL}|g" \
        -e "s|__NEXT_PUBLIC_SUPABASE_ANON_KEY__|${E_SUPABASE_ANON_KEY}|g" \
        -e "s|__NEXT_PUBLIC_APP_URL__|${E_APP_URL}|g" \
        -e "s|__NEXT_PUBLIC_VAPID_PUBLIC_KEY__|${E_VAPID_PUBLIC_KEY}|g" \
        -e "s|__NEXT_PUBLIC_SELF_HOSTED__|${E_SELF_HOSTED}|g" \
        -e "s|__NEXT_PUBLIC_REQUIRE_MFA__|${E_REQUIRE_MFA}|g" \
        -e "s|__NEXT_PUBLIC_SESSION_IDLE_TIMEOUT_MS__|${E_SESSION_IDLE_TIMEOUT_MS}|g" \
        -e "s|__NEXT_PUBLIC_SESSION_ABSOLUTE_TIMEOUT_MS__|${E_SESSION_ABSOLUTE_TIMEOUT_MS}|g" \
        -e "s|__NEXT_PUBLIC_SESSION_WARNING_MS__|${E_SESSION_WARNING_MS}|g" \
        -e "s|__NEXT_PUBLIC_SESSION_TIMEOUT_FORCE_ALL__|${E_SESSION_TIMEOUT_FORCE_ALL}|g" \
        -e "s|__NEXT_PUBLIC_TURNSTILE_SITE_KEY__|${E_TURNSTILE_SITE_KEY}|g" \
        -e "s|__NEXT_PUBLIC_BRANDING_APP_NAME__|${E_BRANDING_APP_NAME}|g"
fi

# ─── Make the served bundle immutable (defense in depth) ───
# nextjs owns these files, so a compromised Node process could chmod them
# back; dropping the write bits still raises the bar against casual tampering.
# (Root-owned immutability isn't possible without running the entrypoint as
# root, which would reintroduce the CAP_CHOWN/CAP_SETUID requirement.)
chmod -R a-w /app/.next/static 2>/dev/null || true
[ -d /app/.next/server ] && chmod -R a-w /app/.next/server 2>/dev/null || true
find /app/.next -maxdepth 1 -type f -exec chmod a-w {} + 2>/dev/null || true
[ -f /app/public/sw.js ] && chmod a-w /app/public/sw.js 2>/dev/null || true

exec "$@"
