/**
 * GET /api/v1/companies/{companyId}/agreement-obligations: the payments the
 * agreements say fall due and whether each arrived in the bank (operation
 * agreements.list-obligations).
 *
 * Contract, docs and rules live in src/lib/operations/commitments.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { agreementsListObligations } from '@/lib/operations/commitments'

export const GET = v1OperationHandler(agreementsListObligations)
