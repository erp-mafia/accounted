import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { getCompanyPaymentVerification, startCompanyPaymentVerification } from '@/lib/payments/orders/availability'

ensureInitialized()

/** GET /api/payments/verification: has the payment provider verified the company (know your customer). */
export const GET = withRouteContext('payments.verification_status', async (_request, { supabase, companyId, user, log, requestId }) => {
  const outcome = await getCompanyPaymentVerification({ supabase, companyId, userId: user.id, log })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})

/** POST /api/payments/verification: a link to the provider's verification form for the company. */
export const POST = withRouteContext(
  'payments.verification_start',
  async (_request, { supabase, companyId, user, log, requestId }) => {
    const outcome = await startCompanyPaymentVerification({ supabase, companyId, userId: user.id, log })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
