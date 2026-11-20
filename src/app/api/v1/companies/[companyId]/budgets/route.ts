/**
 * /api/v1/companies/{companyId}/budgets: the company's budgets.
 *
 * GET  : list them (operation budgets.list).
 * POST : create one for a fiscal year (operation budgets.create).
 *
 * Contracts, docs and rules live in src/lib/operations/budgets.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { budgetsCreate, budgetsList } from '@/lib/operations/budgets'

export const GET = v1OperationHandler(budgetsList)
export const POST = v1OperationHandler(budgetsCreate)
