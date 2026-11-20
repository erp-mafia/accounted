import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { holdMeeting } from '@/lib/bolaget/meetings/store'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { sessionFailureResponse } from '@/lib/operations/session'

type Params = { params: Promise<{ id: string }> }

/** POST /api/bolaget/meetings/{id}/hold (?dry_run=true previews): mark the meeting as held (operation corporate-meetings.hold). */
export const POST = withRouteContext<Params>(
  'bolaget.meeting_hold',
  async (request, ctx, { params }) => {
    const { id } = await params
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const dryRun = new URL(request.url).searchParams.get('dry_run') === 'true'
    const outcome = await holdMeeting(operationContext(ctx), id, { dryRun })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data, warnings: outcome.warnings ?? [] })
  },
  { requireWrite: true },
)
