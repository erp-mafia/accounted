/**
 * GET /api/v1/companies/{companyId}/reports/budget-vs-actual: budget against
 * booked result per account and month (operation reports.budget-vs-actual).
 *
 * Contracts, docs and rules live in src/lib/operations/budgets.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { reportsBudgetVsActual } from '@/lib/operations/budgets'

export const GET = v1OperationHandler(reportsBudgetVsActual)
