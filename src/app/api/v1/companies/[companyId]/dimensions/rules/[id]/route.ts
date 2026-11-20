/**
 * /api/v1/companies/{companyId}/dimensions/rules/{id}: one account
 * dimension rule.
 *
 * PATCH  : change, pause or resume it (operation dimension-rules.update).
 * DELETE : remove it (operation dimension-rules.delete).
 *
 * Contracts, docs and rules live in src/lib/operations/dimension-rules.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { dimensionRulesDelete, dimensionRulesUpdate } from '@/lib/operations/dimension-rules'

export const PATCH = v1OperationHandler(dimensionRulesUpdate)
export const DELETE = v1OperationHandler(dimensionRulesDelete)
