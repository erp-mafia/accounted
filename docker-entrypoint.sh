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

# Populate writable mount points from the baked-in templates. Under
# docker-compose's read_only:true, /app/.next and /app/public are tmpfs
# mounts; cp populates them in RAM. Without read_only:true the directories
# were created empty in the Dockerfile, so cp still works.
if [ -d /opt/gnubok-template/.next ]; then
  cp -R /opt/gnubok-template/.next/. /app/.next/
fi
if [ -d /opt/gnubok-template/public ]; then
  cp -R /opt/gnubok-template/public/. /app/public/
fi

# Ensure Next.js's runtime cache directory is writable by the unprivileged user.
mkdir -p /app/.next/cache
chown -R nextjs:nodejs /app/.next/cache
chmod 755 /app/.next/cache

# Substitute build-time placeholder sentinels with runtime env values.
find /app/.next -type f \( -name '*.js' -o -name '*.html' -o -name '*.rsc' -o -name '*.meta' -o -name '*.body' \) -exec sed -i \
  -e "s|__NEXT_PUBLIC_SUPABASE_URL__|${NEXT_PUBLIC_SUPABASE_URL}|g" \
  -e "s|__NEXT_PUBLIC_SUPABASE_ANON_KEY__|${NEXT_PUBLIC_SUPABASE_ANON_KEY}|g" \
  -e "s|__NEXT_PUBLIC_APP_URL__|${NEXT_PUBLIC_APP_URL}|g" \
  -e "s|__NEXT_PUBLIC_VAPID_PUBLIC_KEY__|${NEXT_PUBLIC_VAPID_PUBLIC_KEY:-}|g" \
  -e "s|__NEXT_PUBLIC_SELF_HOSTED__|${NEXT_PUBLIC_SELF_HOSTED:-true}|g" \
  -e "s|__NEXT_PUBLIC_REQUIRE_MFA__|${NEXT_PUBLIC_REQUIRE_MFA:-false}|g" \
  -e "s|__NEXT_PUBLIC_BRANDING_APP_NAME__|${NEXT_PUBLIC_BRANDING_APP_NAME:-Gnubok}|g" \
  {} +

# Stamp the service worker fallback notification title with the brand name.
# public/sw.js is served as a static file (not bundled by Next), so NEXT_PUBLIC_*
# inlining doesn't reach it.
if [ -f /app/public/sw.js ]; then
  sed -i \
    -e "s|__NEXT_PUBLIC_BRANDING_APP_NAME__|${NEXT_PUBLIC_BRANDING_APP_NAME:-Gnubok}|g" \
    /app/public/sw.js
fi

# Make the served JS bundle immutable. A runtime RCE in the Node process
# cannot rewrite what other users will receive. Cache stays writable so
# Next.js can populate its image-optimization / ISR caches.
chmod -R a-w /app/.next/static
[ -d /app/.next/server ] && chmod -R a-w /app/.next/server
find /app/.next -maxdepth 1 -type f -exec chmod a-w {} +
[ -f /app/public/sw.js ] && chmod a-w /app/public/sw.js

# Drop privileges. The Node server runs as the unprivileged nextjs:nodejs user;
# the now-immutable static dir is root-owned, so even a process compromise
# inside Node cannot rewrite the served JS bundle.
exec su-exec nextjs:nodejs "$@"
