import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { bookDividend } from '@/lib/bolaget/capital/dividends'
import { DividendBookBody } from '@/lib/bolaget/capital/schemas'
import { isUuid } from '@/lib/invariants/uuid'

/**
 * POST /api/bolaget/capital/dividends/{id}/book: book the decision through
 * the engine, D 2098 or 2091 / K 2898 (?dry_run=true previews). The same
 * rules as operation dividends.book.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bolaget.dividend_book',
  async (request, ctx, { params }) => {
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const { id } = await params
    if (!isUuid(id)) return errorResponseFromCode('DIVIDEND_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    const validation = await validateBody(request, DividendBookBody)
    if (!validation.success) return validation.response
    const dryRun = new URL(request.url).searchParams.get('dry_run') === 'true'
    const outcome = await bookDividend(operationContext(ctx), { ...validation.data, dividend_id: id }, { dryRun })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data, warnings: outcome.warnings ?? [] })
  },
  { requireWrite: true },
)
