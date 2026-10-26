import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { signingAvailable } from '@/lib/signing/requests'

/**
 * GET /api/signing/availability: whether signing with BankID is open here
 * (the SIGNING_ENABLED switch and a wired BankID provider). The dashboard
 * hides every signing affordance while it answers false. Read-only; reading
 * existing requests and their signed copies never depends on it.
 */
export const GET = withRouteContext('signing.availability', async () => {
  return NextResponse.json({ data: { available: await signingAvailable() } })
})
