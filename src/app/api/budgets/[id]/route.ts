import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { isUuid } from '@/lib/invariants/uuid'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { UpdateBudgetInputSchema } from '@/lib/budgets/schemas'
import { deleteBudget, updateBudget } from '@/lib/budgets/service'
import { sessionContext, withBudgetId } from '@/lib/budgets/session'

type Params = { params: Promise<{ id: string }> }

/**
 * PATCH /api/budgets/:id: rename, make the year's default, archive or
 * restore. DELETE /api/budgets/:id: remove the budget and its amounts (a
 * budget is planning data, not räkenskapsinformation). The dashboard door of
 * budgets.update and budgets.delete.
 */
export const PATCH = withRouteContext<Params>(
  'budgets.update',
  async (request, ctx, { params }) => {
    const { id } = await params
    const body = await validateBody(request, withBudgetId(id, UpdateBudgetInputSchema))
    if (!body.success) return body.response
    const outcome = await updateBudget(sessionContext(ctx), body.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    return NextResponse.json({ data: outcome.dryRun ? outcome.preview : outcome.data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<Params>(
  'budgets.delete',
  async (_request, ctx, { params }) => {
    const { id } = await params
    if (!isUuid(id)) return errorResponseFromCode('BUDGET_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    const outcome = await deleteBudget(sessionContext(ctx), id)
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    return NextResponse.json({ data: outcome.dryRun ? outcome.preview : outcome.data })
  },
  { requireWrite: true },
)
