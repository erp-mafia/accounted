import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { resolveLandingDestination } from '@/lib/company/landing-server'

/**
 * GET /api/clients/landing
 *
 * Post-login landing decision (WL-14): thin HTTP wrapper around
 * resolveLandingDestination (lib/company/landing-server.ts), for the client
 * auth surfaces (login and MFA-verify pages) that cannot call it in-process.
 * Called when no explicit destination was requested; any failure degrades to
 * '/' at the caller.
 */
export const GET = withRouteContext('clients.landing', async (request, ctx) => {
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? ''
  const destination = await resolveLandingDestination(ctx.supabase, ctx.user.id, host)
  return NextResponse.json({ data: { destination } })
})
