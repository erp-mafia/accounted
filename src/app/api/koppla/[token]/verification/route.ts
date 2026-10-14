import { NextResponse } from 'next/server'
import { withInviteToken } from '@/lib/bank-feed/invite-route'
import { sessionFailureResponse } from '@/lib/operations/session'
import { getCompanyPaymentVerification } from '@/lib/payments/orders/availability'

/**
 * GET /api/koppla/:token/verification: has the payment provider verified the
 * company (know your customer), and where it stands (state). Only a link that
 * offers payments answers; PAYMENTS_UNAVAILABLE (403) when the company may not
 * pay through the bank. `?refresh=1` asks the provider even when the stored
 * answer is fresh. Mirrors GET /api/payments/verification.
 */
export const GET = withInviteToken<{ token: string }>('payments.verification_status', { stage: 'follow_up' }, async (request, { invite, op, log, requestId }) => {
  if (!invite.offer_payments) return sessionFailureResponse({ ok: false, code: 'PAYMENTS_UNAVAILABLE', details: { reason: 'not_offered' } }, log, requestId)
  const refresh = new URL(request.url).searchParams.get('refresh') === '1'
  const outcome = await getCompanyPaymentVerification(op, { refresh })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})
