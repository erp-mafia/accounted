import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { CreateBudgetInputSchema, ListBudgetsInputSchema } from '@/lib/budgets/schemas'
import { createBudget, listBudgets } from '@/lib/budgets/service'
import { sessionContext } from '@/lib/budgets/session'

/**
 * GET /api/budgets?fiscal_period_id=: the year's budgets, for the /budget
 * page and the reports' budget picker. POST /api/budgets: a new named budget.
 * The dashboard door of budgets.list and budgets.create
 * (lib/operations/budgets.ts), over the same service.
 */
export const GET = withRouteContext('budgets.list', async (request, ctx) => {
  const query = validateQuery(request, ListBudgetsInputSchema)
  if (!query.success) return query.response
  const outcome = await listBudgets(sessionContext(ctx), query.data)
  if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
  return NextResponse.json({ data: outcome.dryRun ? outcome.preview : outcome.data })
})

export const POST = withRouteContext(
  'budgets.create',
  async (request, ctx) => {
    const body = await validateBody(request, CreateBudgetInputSchema)
    if (!body.success) return body.response
    const outcome = await createBudget(sessionContext(ctx), body.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    return NextResponse.json({ data: outcome.dryRun ? outcome.preview : outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
