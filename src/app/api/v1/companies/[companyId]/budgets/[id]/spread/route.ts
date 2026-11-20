/**
 * POST /api/v1/companies/{companyId}/budgets/{id}/spread: spread a yearly
 * amount over the budget's months (operation budgets.spread).
 *
 * Contracts, docs and rules live in src/lib/operations/budgets.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { budgetsSpread } from '@/lib/operations/budgets'

export const POST = v1OperationHandler(budgetsSpread)
