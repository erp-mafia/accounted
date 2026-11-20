import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionContext } from '@/lib/budgets/session'
import { budgetImportDoor } from '@/lib/import/budget/session-door'

/**
 * POST /api/budgets/:id/import/preview, multipart as ../import: what the file
 * would do to the budget (rows read, cells, what is skipped and why, the
 * budget per class and the result), through the save's own dry run. Writes
 * nothing, so a reader may run it.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'budgets.import.preview',
  async (request, ctx, { params }) => {
    const { id } = await params
    return budgetImportDoor(request, { ...sessionContext(ctx), requestId: ctx.requestId }, id, true)
  },
)
