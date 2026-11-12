import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { listBankFeedBanks } from '@/lib/bank-feed/service'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * GET /api/bank/open-payments/banks: the banks a company can connect with
 * BankID through Open Payments. The door runs first. Six pages ask this on
 * load to decide which bank entry points to show, so for a company the door
 * does not admit "not available" is the answer, a 200 with `available: false`
 * (and no banks), which the browser reads as "hide every entry point". As a
 * 403 it was 100 failed requests a week (2026-11) from pages that had done
 * nothing wrong. The doors that start a connection still refuse with
 * OPEN_BANKING_NOT_AVAILABLE.
 */
export const GET = withRouteContext('bank_feed.banks', async (_request, { supabase, companyId, user, log, requestId }) => {
  const outcome = await listBankFeedBanks({ supabase, companyId, userId: user.id, log })
  if (!outcome.ok && outcome.code === 'OPEN_BANKING_NOT_AVAILABLE') {
    const details = outcome.details as { reason?: unknown } | undefined
    return NextResponse.json({ data: { available: false, banks: [], reason: details?.reason ?? null } })
  }
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})
