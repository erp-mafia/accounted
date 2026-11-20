import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { deleteDecision } from '@/lib/bolaget/meetings/store'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { sessionFailureResponse } from '@/lib/operations/session'

type Params = { params: Promise<{ id: string; decisionId: string }> }

/** DELETE /api/bolaget/meetings/{id}/decisions/{decisionId}: remove a paragraph from unsigned minutes; the rest are renumbered. */
export const DELETE = withRouteContext<Params>(
  'bolaget.meeting_decision_delete',
  async (_request, ctx, { params }) => {
    const { id, decisionId } = await params
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const outcome = await deleteDecision(operationContext(ctx), id, decisionId)
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
