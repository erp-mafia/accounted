import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { CopyActualsInputSchema } from '@/lib/budgets/schemas'
import { copyActualsToBudget } from '@/lib/budgets/service'
import { isDryRun, sessionContext, withBudgetId } from '@/lib/budgets/session'

/**
 * POST /api/budgets/:id/copy-actuals[?dry_run=true]: last year's booked
 * result month by month, optionally scaled. The dry run is the confirm
 * dialog's preview. The dashboard door of budgets.copy-actuals.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'budgets.copy_actuals',
  async (request, ctx, { params }) => {
    const { id } = await params
    const body = await validateBody(request, withBudgetId(id, CopyActualsInputSchema))
    if (!body.success) return body.response
    const outcome = await copyActualsToBudget(sessionContext(ctx), body.data, { dryRun: isDryRun(request) })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    return NextResponse.json({ data: outcome.dryRun ? outcome.preview : outcome.data })
  },
  { requireWrite: true },
)
