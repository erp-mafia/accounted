import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionContext } from '@/lib/budgets/session'
import { budgetImportDoor } from '@/lib/import/budget/session-door'

/**
 * POST /api/budgets/:id/import, multipart: file, and optionally sign
 * (debit_positive | revenue_positive) and replace (true). "Importera budget"
 * on the /budget page, after its preview (./preview): the same plan, saved in
 * one call. Separate from the ledger's SIE import job. The dashboard door of
 * budgets.import.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'budgets.import',
  async (request, ctx, { params }) => {
    const { id } = await params
    return budgetImportDoor(request, { ...sessionContext(ctx), requestId: ctx.requestId }, id, false)
  },
  { requireWrite: true },
)
