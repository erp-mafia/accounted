import { NextResponse, type NextRequest } from 'next/server'
import { usesForbiddenWhiteLabelBackend } from '@/lib/domains/production-white-label-backend'
import { createLogger } from '@/lib/logger'
import { updateSession } from '@/lib/supabase/middleware'

const log = createLogger('proxy')

export async function proxy(request: NextRequest) {
  if (
    usesForbiddenWhiteLabelBackend(
      request.nextUrl.hostname,
      process.env.NEXT_PUBLIC_SUPABASE_URL,
    )
  ) {
    log.error('Blocked production white-label host from staging backend', {
      alert: true,
      operation: 'white_label_backend_guard',
      requestHostname: request.nextUrl.hostname,
      backendClassification: 'staging',
    })

    return new NextResponse(null, {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
      },
    })
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
