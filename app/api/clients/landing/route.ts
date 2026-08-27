import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { resolveLandingDestination } from '@/lib/company/landing-server'

/**
 * GET /api/clients/landing
 *
 * Post-login landing decision (WL-14): thin HTTP wrapper around
 * resolveLandingDestination (lib/company/landing-server.ts), for the client
 * auth surfaces (login and MFA-verify pages) that cannot call it in-process.
 * The helper carries the whole rule, including the owner/admin role gate
 * (2026-08-27). Called when no explicit destination was requested; any
 * failure degrades to '/' at the caller.
 *
 * Uses requireAuth() directly (the sanctioned withRouteContext opt-out, MFA
 * still enforced) because the decision needs no active company. Byrå staff
 * without a company of their own are the cockpit's primary persona and must
 * still land on /clients; withRouteContext would 4xx them with
 * COMPANY_CONTEXT_MISSING.
 */
export async function GET(request: Request) {
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { user, supabase } = auth

  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? ''
  const destination = await resolveLandingDestination(supabase, user.id, host)
  return NextResponse.json({ data: { destination } })
}
