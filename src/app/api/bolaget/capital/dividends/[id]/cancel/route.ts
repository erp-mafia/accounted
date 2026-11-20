import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { cancelDividend } from '@/lib/bolaget/capital/dividends'
import { isUuid } from '@/lib/invariants/uuid'

/** POST /api/bolaget/capital/dividends/{id}/cancel: cancel a dividend recorded by mistake, while nothing is booked. */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bolaget.dividend_cancel',
  async (_request, ctx, { params }) => {
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const { id } = await params
    if (!isUuid(id)) return errorResponseFromCode('DIVIDEND_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    const outcome = await cancelDividend(operationContext(ctx), id)
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
