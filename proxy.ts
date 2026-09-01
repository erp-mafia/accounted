import { NextResponse, type NextRequest } from 'next/server'
import { usesForbiddenWhiteLabelBackend } from '@/lib/domains/production-white-label-backend'
import { createLogger } from '@/lib/logger'
import { updateSession } from '@/lib/supabase/middleware'

const log = createLogger('proxy')

// Both guards below flag their record `alert: true`, and from here that flag
// pages nobody: the observability sink is only ever registered by lib/init.ts,
// which middleware must not call (it would drag the extension registry and the
// analytics client into the middleware bundle). The flag stays as the record's
// intent; the rule that turns one of these lines into an alert is configured on
// the hosting side, matching the stable `operation` field of the emitted JSON.

/**
 * Empty, non-cacheable 503. The body stays empty on purpose: the deployment is
 * already known to be wired wrong, so the response must not echo a hostname, a
 * backend URL or a credential back to whoever asked.
 */
function serviceUnavailable(): NextResponse {
  return new NextResponse(null, {
    status: 503,
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}

/**
 * Whether a build-time public value never made it into the bundle: absent,
 * empty, or still the `__NEXT_PUBLIC_*__` sentinel the Dockerfile bakes in and
 * docker-entrypoint.sh substitutes at container start. Mirrors the check in
 * lib/supabase/client.ts.
 *
 * Takes the value as an argument rather than reading process.env itself: an
 * in-place comparison of a NEXT_PUBLIC_* var is constant-folded at build time
 * and erases the sentinel the entrypoint needs to find. See
 * lib/env/public-flags.ts.
 */
function isMissingPublicValue(value: string | undefined): boolean {
  return !value || value.startsWith('__')
}

/**
 * The Supabase browser env vars that updateSession needs, by name, or an empty
 * list when the deployment is configured.
 *
 * Static property reads, never a `process.env[name]` loop: Next.js substitutes
 * only literal references at build time, so a dynamic lookup would report a
 * healthy deployment as unconfigured and 503 every request on every path.
 */
function missingSupabaseEnv(): string[] {
  const missing: string[] = []

  if (isMissingPublicValue(process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    missing.push('NEXT_PUBLIC_SUPABASE_URL')
  }
  if (isMissingPublicValue(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)) {
    missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY')
  }

  return missing
}

export async function proxy(request: NextRequest) {
  // Ahead of everything, because everything below needs a Supabase client.
  // updateSession builds one with non-null assertions and @supabase/ssr throws
  // synchronously when either value is falsy: that throw escapes the Web
  // Handler and 500s every path the matcher covers, /login and /robots.txt
  // included, with no log line to find it by. Preview deployments built
  // without the vars stayed bricked that way for weeks.
  const missingEnv = missingSupabaseEnv()
  if (missingEnv.length > 0) {
    log.error('Refused request without Supabase configuration', {
      alert: true,
      operation: 'supabase_env_missing',
      requestHostname: request.nextUrl.hostname,
      missing: missingEnv,
    })

    return serviceUnavailable()
  }

  if (
    usesForbiddenWhiteLabelBackend(
      request.nextUrl.hostname,
      process.env.NEXT_PUBLIC_SUPABASE_URL,
    )
  ) {
    // Renamed from 'Blocked production white-label host from staging backend'.
    // The guard asserts the production project rather than naming one
    // forbidden project, so the staging project, a third project and a backend
    // URL the build cannot parse all land here. `operation` is unchanged: it is
    // what a hosting-side alert rule matches on.
    log.error(
      'Blocked production white-label host from a non-production backend',
      {
        alert: true,
        operation: 'white_label_backend_guard',
        requestHostname: request.nextUrl.hostname,
        backendClassification: 'non_production',
      },
    )

    return serviceUnavailable()
  }

  return await updateSession(request)
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - Static assets (images, scripts, manifest, icons, etc.)
     *
     * NOTE: `/api` is intentionally INCLUDED so the proxy can enforce the MFA
     * (AAL2) gate on cookie-authenticated API calls (updateSession short-
     * circuits API routes after that check: see lib/supabase/middleware.ts).
     *
     * `/rl` is the PostHog reverse-proxy prefix (rewrites in next.config.ts).
     * It MUST be excluded: middleware runs BEFORE next.config rewrites, so
     * without this updateSession() treats an ingestion POST as an unknown
     * protected path and 307s it to /login. That silently kills analytics on
     * every logged-out page and, because flags and asset loads still succeed
     * through the rewrite, the integration looks healthy while no events
     * arrive. Keep in sync with `api_host` in instrumentation-client.ts.
     */
    '/((?!_next/static|_next/image|favicon.ico|\\.well-known|rl/|sw\\.js|sw-register\\.js|manifest\\.json|manifest\\.webmanifest|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|js|json)$).*)',
  ],
}
