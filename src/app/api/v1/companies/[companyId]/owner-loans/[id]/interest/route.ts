/**
 * POST /api/v1/companies/{companyId}/owner-loans/{id}/interest: record the
 * interest on an owner loan for an inkomstår (operation owner-loans.set-interest).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget-owner-tax.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { ownerLoansSetInterest } from '@/lib/operations/bolaget-owner-tax'

export const POST = v1OperationHandler(ownerLoansSetInterest)
