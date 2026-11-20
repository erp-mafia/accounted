/**
 * POST /api/v1/companies/{companyId}/budgets/{id}/lines: save budget cells
 * (account, month, dimension), all or none (operation budgets.lines.upsert).
 *
 * Contracts, docs and rules live in src/lib/operations/budgets.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { budgetsLinesUpsert } from '@/lib/operations/budgets'

export const POST = v1OperationHandler(budgetsLinesUpsert)
