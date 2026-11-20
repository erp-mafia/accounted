import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { SpreadInputSchema } from '@/lib/budgets/schemas'
import { spreadBudget } from '@/lib/budgets/service'
import { isDryRun, sessionContext, withBudgetId } from '@/lib/budgets/session'

/**
 * POST /api/budgets/:id/spread[?dry_run=true]: one account's yearly amount
 * over the months, evenly or by last year's months. The dashboard door of
 * budgets.spread.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'budgets.spread',
  async (request, ctx, { params }) => {
    const { id } = await params
    const body = await validateBody(request, withBudgetId(id, SpreadInputSchema))
    if (!body.success) return body.response
    const outcome = await spreadBudget(sessionContext(ctx), body.data, { dryRun: isDryRun(request) })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    return NextResponse.json({ data: outcome.dryRun ? outcome.preview : outcome.data })
  },
  { requireWrite: true },
)
