/**
 * /api/v1/companies/{companyId}/budgets/{id}: one budget.
 *
 * GET    : read it with its amounts (operation budgets.get).
 * PATCH  : rename, make default, archive or restore (operation budgets.update).
 * DELETE : remove it and its amounts (operation budgets.delete).
 *
 * Contracts, docs and rules live in src/lib/operations/budgets.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { budgetsDelete, budgetsGet, budgetsUpdate } from '@/lib/operations/budgets'

export const GET = v1OperationHandler(budgetsGet)
export const PATCH = v1OperationHandler(budgetsUpdate)
export const DELETE = v1OperationHandler(budgetsDelete)
