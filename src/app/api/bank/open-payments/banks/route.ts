import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { listBankFeedBanks } from '@/lib/bank-feed/service'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * GET /api/bank/open-payments/banks: the banks a company can connect with
 * BankID through Open Payments. The door runs first: a company the pilot does
 * not admit gets 403 OPEN_BANKING_NOT_AVAILABLE, which the browser reads as
 * "hide every entry point".
 */
export const GET = withRouteContext('bank_feed.banks', async (_request, { supabase, companyId, user, log, requestId }) => {
  const outcome = await listBankFeedBanks({ supabase, companyId, userId: user.id, log })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})
