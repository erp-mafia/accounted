/**
 * POST /api/v1/companies/{companyId}/budgets/{id}/copy-actuals: fill a budget
 * with last year's booked result, optionally scaled (operation
 * budgets.copy-actuals).
 *
 * Contracts, docs and rules live in src/lib/operations/budgets.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { budgetsCopyActuals } from '@/lib/operations/budgets'

export const POST = v1OperationHandler(budgetsCopyActuals)
