import { NextResponse } from 'next/server'
import { withInviteToken } from '@/lib/bank-feed/invite-route'
import { listBankFeedBanks } from '@/lib/bank-feed/service'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * GET /api/koppla/:token/banks: the banks the firmatecknare can connect with
 * BankID, for the company the link names. Mirrors GET /api/bank/open-payments/banks:
 * the door answers 403 OPEN_BANKING_NOT_AVAILABLE for a company not switched on.
 */
export const GET = withInviteToken<{ token: string }>('bank_feed.banks', { stage: 'open' }, async (_request, { op, log, requestId }) => {
  const outcome = await listBankFeedBanks(op)
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})
