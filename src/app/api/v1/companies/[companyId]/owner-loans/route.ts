/**
 * GET /api/v1/companies/{companyId}/owner-loans: the owner loan register
 * with the låneförbud check and the ledger reconciliation (operation
 * owner-loans.get). POST registers a loan (operation owner-loans.create).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget-owner-tax.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { ownerLoansCreate, ownerLoansGet } from '@/lib/operations/bolaget-owner-tax'

export const GET = v1OperationHandler(ownerLoansGet)
export const POST = v1OperationHandler(ownerLoansCreate)
