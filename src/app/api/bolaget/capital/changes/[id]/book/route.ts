import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { bookCapitalChange } from '@/lib/bolaget/capital/capital-changes'
import { CapitalChangeBookBody } from '@/lib/bolaget/capital/schemas'
import { isUuid } from '@/lib/invariants/uuid'

/**
 * POST /api/bolaget/capital/changes/{id}/book: book a nyemission's payment
 * or the registration of a capital change (?dry_run=true previews). The
 * same rules as operation capital-changes.book.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bolaget.capital_change_book',
  async (request, ctx, { params }) => {
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const { id } = await params
    if (!isUuid(id)) return errorResponseFromCode('CAPITAL_CHANGE_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    const validation = await validateBody(request, CapitalChangeBookBody)
    if (!validation.success) return validation.response
    const dryRun = new URL(request.url).searchParams.get('dry_run') === 'true'
    const outcome = await bookCapitalChange(operationContext(ctx), { ...validation.data, capital_change_id: id }, { dryRun })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
