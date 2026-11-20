import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { BudgetGridInputSchema } from '@/lib/budgets/schemas'
import { budgetGrid } from '@/lib/budgets/service'
import { sessionContext, withBudgetId } from '@/lib/budgets/session'

/**
 * GET /api/budgets/:id/grid?mode=&dim_no=&dim_code=: the /budget page's
 * account x month grid, summed in the database. The untagged lines and one
 * exact tag are editable; mode=sum adds every tag together (a budget per
 * home), read-only. Amounts in the SIE sign, as stored.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>('budgets.grid', async (request, ctx, { params }) => {
  const { id } = await params
  const query = validateQuery(request, withBudgetId(id, BudgetGridInputSchema))
  if (!query.success) return query.response
  const outcome = await budgetGrid(sessionContext(ctx), query.data)
  if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
  return NextResponse.json({ data: outcome.dryRun ? outcome.preview : outcome.data })
})
