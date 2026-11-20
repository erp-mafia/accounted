import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { disconnectPosConnection } from '@/lib/pos-sales/service'

/**
 * End a POS connection: no more days are fetched; fetched and booked days
 * stay. Rules in lib/pos-sales/service.ts, shared with the operation
 * pos-sales.disconnect.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'pos_sales.disconnect',
  async (_request, ctx, { params }) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const { id } = await params
    const outcome = await disconnectPosConnection({ supabase, companyId: companyId!, userId: user.id, log }, { connection_id: id })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('unreachable: no dry run on the dashboard')
    return NextResponse.json({ data: outcome.data, ...(outcome.warnings ? { warnings: outcome.warnings } : {}) })
  },
  { requireWrite: true },
)
