import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { dividendsCreate } from '@/lib/operations/bolaget-capital'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { createDividend } from '@/lib/bolaget/capital/dividends'

/**
 * POST /api/bolaget/capital/dividends: record a dividend the stämma decided
 * and split it per holder (?dry_run=true previews). The same rules as
 * operation dividends.create.
 */
export const POST = withRouteContext(
  'bolaget.dividend_create',
  async (request, ctx) => {
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const validation = await validateBody(request, dividendsCreate.input)
    if (!validation.success) return validation.response
    const dryRun = new URL(request.url).searchParams.get('dry_run') === 'true'
    const outcome = await createDividend(operationContext(ctx), validation.data, { dryRun })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data, warnings: outcome.warnings ?? [] }, { status: 201 })
  },
  { requireWrite: true },
)
