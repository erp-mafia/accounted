import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function proxy(request: NextRequest) {
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
     */
    '/((?!_next/static|_next/image|favicon.ico|\\.well-known|sw\\.js|sw-register\\.js|manifest\\.json|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|js|json)$).*)',
  ],
}
