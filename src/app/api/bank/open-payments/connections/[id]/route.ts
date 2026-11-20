import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { disconnectBankFeedConnection, getBankFeedConnection } from '@/lib/bank-feed/service'
import { sessionFailureResponse } from '@/lib/operations/session'

/** GET /api/bank/open-payments/connections/:id: one connection as the dashboard shows it. */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bank_feed.connection',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const outcome = await getBankFeedConnection({ supabase, companyId, userId: user.id, log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
)

/**
 * DELETE /api/bank/open-payments/connections/:id: remove the connection
 * (history stays, cash-account claims are released) and end its consent at
 * the bank under the openpayments revocation claim.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bank_feed.disconnect',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const outcome = await disconnectBankFeedConnection({ supabase, companyId, userId: user.id, log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
