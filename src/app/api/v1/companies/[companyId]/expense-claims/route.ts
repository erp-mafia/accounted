/**
 * GET  /api/v1/companies/{companyId}/expense-claims: list the utlägg register
 * (operation expense-claims.list).
 * POST /api/v1/companies/{companyId}/expense-claims: register a claim and post
 * its verifikat (operation expense-claims.create).
 *
 * Contracts, docs and rules in src/lib/operations/expense-claims.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { expenseClaimsCreate, expenseClaimsList } from '@/lib/operations/expense-claims'

export const GET = v1OperationHandler(expenseClaimsList)
export const POST = v1OperationHandler(expenseClaimsCreate)
