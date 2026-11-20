import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getBankFeedBankDetails } from '@/lib/bank-feed/service'
import { sessionFailureResponse } from '@/lib/operations/session'

const BIC = /^[A-Z0-9]{8}([A-Z0-9]{3})?$/

/**
 * GET /api/bank/open-payments/banks/:bic: one bank's details, read when the
 * person picks it: whether it signs BankID in our screen or on its own page,
 * and the sparbanker behind a shared BIC (SWEDSESS). Served from a 24 h
 * cache in the adapter. The door runs first, as for the list.
 */
export const GET = withRouteContext<{ params: Promise<{ bic: string }> }>(
  'bank_feed.bank',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { bic } = await params
    const upper = bic.toUpperCase()
    if (!BIC.test(upper)) {
      return sessionFailureResponse({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'bic', reason: 'malformed' } }, log, requestId)
    }
    const outcome = await getBankFeedBankDetails({ supabase, companyId, userId: user.id, log }, upper)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
)
