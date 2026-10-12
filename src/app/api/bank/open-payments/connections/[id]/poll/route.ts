import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { pollBankFeedConsent } from '@/lib/bank-feed/service'
import { sessionFailureResponse } from '@/lib/operations/session'
import { signerFromRequest } from '@/lib/payments/orders/request-signer'

/**
 * POST /api/bank/open-payments/connections/:id/poll: where the BankID stands.
 * No body: the row carries the consent, the authorisation and the method.
 * While pending it answers fresh QR data (the animated QR changes every
 * second); once the bank reports the consent valid, the accounts it reaches
 * are read and the connection awaits account selection.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bank_feed.poll',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const outcome = await pollBankFeedConsent(
      { supabase, companyId, userId: user.id, log },
      { connectionId: id, signer: signerFromRequest(request, null) },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
