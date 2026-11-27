import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { disconnectSpendConnection } from '@/lib/spend/service'

/**
 * End a spend connection: no more expenses are received. Received and
 * booked expenses stay. Rules in lib/spend/service.ts, shared with the
 * operation spend.disconnect.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'spend.disconnect',
  async (_request, ctx, { params }) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const { id } = await params
    const outcome = await disconnectSpendConnection({ supabase, companyId: companyId!, userId: user.id, log }, { connection_id: id })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('unreachable: no dry run on the dashboard')
    return NextResponse.json({ data: outcome.data, ...(outcome.warnings ? { warnings: outcome.warnings } : {}) })
  },
  { requireWrite: true, uuidParams: { id: 'SPEND_CONNECTION_NOT_FOUND' } },
)
