/**
 * PATCH /api/v1/companies/{companyId}/agreements/{id}: change a manually
 * registered agreement; its expected payments and dates follow (operation
 * agreements.update).
 *
 * Contract, docs and rules live in src/lib/operations/commitments.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { agreementsUpdate } from '@/lib/operations/commitments'

export const PATCH = v1OperationHandler(agreementsUpdate)
