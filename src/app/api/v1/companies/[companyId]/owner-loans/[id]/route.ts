/**
 * PATCH /api/v1/companies/{companyId}/owner-loans/{id}: update an owner
 * loan (operation owner-loans.update).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget-owner-tax.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { ownerLoansUpdate } from '@/lib/operations/bolaget-owner-tax'

export const PATCH = v1OperationHandler(ownerLoansUpdate)
