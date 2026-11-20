/**
 * POST /api/v1/companies/{companyId}/agreements/{id}/end: end a manually
 * registered agreement (operation agreements.end).
 *
 * Contract, docs and rules live in src/lib/operations/commitments.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { agreementsEnd } from '@/lib/operations/commitments'

export const POST = v1OperationHandler(agreementsEnd)
