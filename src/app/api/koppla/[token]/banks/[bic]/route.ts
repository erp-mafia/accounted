import { NextResponse } from 'next/server'
import { withInviteToken } from '@/lib/bank-feed/invite-route'
import { getBankFeedBankDetails } from '@/lib/bank-feed/service'
import { sessionFailureResponse } from '@/lib/operations/session'

const BIC = /^[A-Z0-9]{8}([A-Z0-9]{3})?$/

/**
 * GET /api/koppla/:token/banks/:bic: one bank's details for the firmatecknare's
 * flow: whether it signs BankID in our screen or on its own page, and the
 * sparbanker behind a shared BIC. Mirrors GET /api/bank/open-payments/banks/:bic.
 */
export const GET = withInviteToken<{ token: string; bic: string }>('bank_feed.bank', { stage: 'open' }, async (_request, { op, log, requestId }, { bic }) => {
  const upper = bic.toUpperCase()
  if (!BIC.test(upper)) {
    return sessionFailureResponse({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'bic', reason: 'malformed' } }, log, requestId)
  }
  const outcome = await getBankFeedBankDetails(op, upper)
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})
