/**
 * POST /api/v1/companies/{companyId}/budgets/{id}/import: read a budget file
 * (SIE #PBUDGET, Excel or CSV, base64) into the budget (operation
 * budgets.import). Dry-runnable: the dry run is the preview.
 *
 * Contracts, docs and rules live in src/lib/operations/budgets.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { budgetsImport } from '@/lib/operations/budgets'

export const POST = v1OperationHandler(budgetsImport)
