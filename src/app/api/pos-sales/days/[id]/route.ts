import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { getPosSalesDay } from '@/lib/pos-sales/service'

/**
 * One POS business day with its receipts and the voucher it books as. Rules
 * in lib/pos-sales/service.ts, shared with the operation pos-sales.day-get.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'pos_sales.day.get',
  async (_request, ctx, { params }) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const { id } = await params
    const outcome = await getPosSalesDay({ supabase, companyId: companyId!, userId: user.id, log }, { day_id: id })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('unreachable: a read')
    return NextResponse.json({ data: outcome.data })
  },
)
