/**
 * GET    /api/v1/companies/{companyId}/expense-claims/{id} (expense-claims.get)
 * DELETE /api/v1/companies/{companyId}/expense-claims/{id} (expense-claims.delete:
 *        storno of the claim's verifikat, never a deleted verifikat)
 *
 * Contracts, docs and rules in src/lib/operations/expense-claims.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { expenseClaimsDelete, expenseClaimsGet } from '@/lib/operations/expense-claims'

export const GET = v1OperationHandler(expenseClaimsGet)
export const DELETE = v1OperationHandler(expenseClaimsDelete)
