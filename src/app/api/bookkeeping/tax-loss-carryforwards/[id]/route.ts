import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { getLossCarryforward } from '@/lib/bokslut/loss-carryforward/register'

/** GET /api/bookkeeping/tax-loss-carryforwards/[id]: one fiscal year of the underskottsregister. */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.tax-loss-carryforwards.get',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const outcome = await getLossCarryforward(ctx, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
)
