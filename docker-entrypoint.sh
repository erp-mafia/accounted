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
  printf "ERROR: Missing required environment variables:\n%b\nSee .env.docker.example for reference.\n" "$missing" >&2
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

# ─── Populate the writable tmpfs mounts from the baked-in templates ───
# Under docker-compose's `read_only: true`, /app/.next and /app/public are
# tmpfs mounts owned by nextjs (uid=1001); this cp fills them in RAM at every
# startup. /app/server.js, /app/node_modules and /app/package.json stay on the
# read-only image layer. Running as the unprivileged nextjs user means no
# CAP_CHOWN / CAP_SETUID is needed, so the container works under `cap_drop: ALL`.
# Without read_only:true the mount points were created empty in the Dockerfile,
# so the same cp still works.
#
# On a non-tmpfs restart the target dirs persist with their write bits removed
# (see the immutability step below), so restore owner-write first: otherwise the
# unprivileged cp -R below fails under `set -e`. Under tmpfs the dirs are empty
# each start, so this is a no-op.
chmod -R u+w /app/.next /app/public 2>/dev/null || true
if [ -d /opt/gnubok-template/.next ]; then
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
  E_SUPABASE_URL=$(sed_esc "$NEXT_PUBLIC_SUPABASE_URL")
  E_SUPABASE_ANON_KEY=$(sed_esc "$NEXT_PUBLIC_SUPABASE_ANON_KEY")
  E_APP_URL=$(sed_esc "$NEXT_PUBLIC_APP_URL")
  E_VAPID_PUBLIC_KEY=$(sed_esc "${NEXT_PUBLIC_VAPID_PUBLIC_KEY:-}")
  E_SELF_HOSTED=$(sed_esc "${NEXT_PUBLIC_SELF_HOSTED:-true}")
  E_REQUIRE_MFA=$(sed_esc "${NEXT_PUBLIC_REQUIRE_MFA:-false}")
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
        -e "s|__NEXT_PUBLIC_SUPABASE_ANON_KEY__|${E_SUPABASE_ANON_KEY}|g" \
        -e "s|__NEXT_PUBLIC_APP_URL__|${E_APP_URL}|g" \
        -e "s|__NEXT_PUBLIC_VAPID_PUBLIC_KEY__|${E_VAPID_PUBLIC_KEY}|g" \
        -e "s|__NEXT_PUBLIC_SELF_HOSTED__|${E_SELF_HOSTED}|g" \
        -e "s|__NEXT_PUBLIC_REQUIRE_MFA__|${E_REQUIRE_MFA}|g" \
        -e "s|__NEXT_PUBLIC_BRANDING_APP_NAME__|${E_BRANDING_APP_NAME}|g"
fi

# ─── Make the served bundle immutable (defense in depth) ───
# nextjs owns these tmpfs files, so a compromised Node process could chmod them
# back; dropping the write bits still raises the bar against casual tampering.
# (Root-owned immutability isn't possible without running the entrypoint as
# root, which would reintroduce the CAP_CHOWN/CAP_SETUID requirement.)
chmod -R a-w /app/.next/static 2>/dev/null || true
[ -d /app/.next/server ] && chmod -R a-w /app/.next/server 2>/dev/null || true
find /app/.next -maxdepth 1 -type f -exec chmod a-w {} + 2>/dev/null || true
[ -f /app/public/sw.js ] && chmod a-w /app/public/sw.js 2>/dev/null || true

exec "$@"
