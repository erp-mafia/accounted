import { NextResponse } from 'next/server'
import { withInviteToken } from '@/lib/bank-feed/invite-route'
import { sessionFailureResponse } from '@/lib/operations/session'
import { startCompanyPaymentVerification } from '@/lib/payments/orders/availability'

/**
 * POST /api/koppla/:token/verification/start: a link to the provider's
 * verification form for the company (valid 24 h), which the firmatecknare
 * fills in and signs. Mirrors POST /api/payments/verification.
 */
export const POST = withInviteToken<{ token: string }>('payments.verification_start', { stage: 'follow_up' }, async (_request, { invite, op, log, requestId }) => {
  if (!invite.offer_payments) return sessionFailureResponse({ ok: false, code: 'PAYMENTS_UNAVAILABLE', details: { reason: 'not_offered' } }, log, requestId)
  const outcome = await startCompanyPaymentVerification(op)
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})
