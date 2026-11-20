import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { recordDecision } from '@/lib/bolaget/meetings/store'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { RecordDecisionIn } from '@/lib/operations/corporate-meetings'
import { sessionFailureResponse } from '@/lib/operations/session'

type Params = { params: Promise<{ id: string }> }

const DecisionSchema = RecordDecisionIn.omit({ corporate_meeting_id: true })

/** POST /api/bolaget/meetings/{id}/decisions: add or change a decision (operation corporate-meetings.decisions.record). */
export const POST = withRouteContext<Params>(
  'bolaget.meeting_decision',
  async (request, ctx, { params }) => {
    const { id } = await params
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const validation = await validateBody(request, DecisionSchema)
    if (!validation.success) return validation.response
    const outcome = await recordDecision(operationContext(ctx), { ...validation.data, corporate_meeting_id: id }, { dryRun: false })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data, warnings: outcome.warnings ?? [] }, { status: outcome.created ? 201 : 200 })
  },
  { requireWrite: true },
)
