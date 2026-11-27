import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { getSpendItem } from '@/lib/spend/service'

/**
 * One spend expense: the model, the reasons it waits for, and the
 * verifikat it books as. Rules in lib/spend/service.ts, shared with the
 * operation spend.item-get.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'spend.item.get',
  async (_request, ctx, { params }) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const { id } = await params
    const outcome = await getSpendItem({ supabase, companyId: companyId!, userId: user.id, log }, { item_id: id })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('unreachable: a read')
    return NextResponse.json({ data: outcome.data })
  },
  { uuidParams: { id: 'SPEND_ITEM_NOT_FOUND' } },
)
