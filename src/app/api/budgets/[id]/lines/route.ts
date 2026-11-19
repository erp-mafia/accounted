import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { UpsertBudgetLinesInputSchema } from '@/lib/budgets/schemas'
import { upsertBudgetLines } from '@/lib/budgets/service'
import { sessionContext, withBudgetId } from '@/lib/budgets/session'

/**
 * POST /api/budgets/:id/lines: the grid's save, every changed cell or none
 * (upsert_budget_lines); 0 removes a cell. SIE sign. The dashboard door of
 * budgets.lines.upsert.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'budgets.lines.upsert',
  async (request, ctx, { params }) => {
    const { id } = await params
    const body = await validateBody(request, withBudgetId(id, UpsertBudgetLinesInputSchema))
    if (!body.success) return body.response
    const outcome = await upsertBudgetLines(sessionContext(ctx), body.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    return NextResponse.json({ data: outcome.dryRun ? outcome.preview : outcome.data })
  },
  { requireWrite: true },
)
