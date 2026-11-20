/**
 * POST /api/v1/companies/{companyId}/assets/{id}/value-adjustments: a nedskrivning or its reversal
 * (operation assets.value-adjustments.create).
 *
 * Contract, docs and rules live in src/lib/operations/k3.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { assetsValueAdjustmentsCreate } from '@/lib/operations/k3'

export const POST = v1OperationHandler(assetsValueAdjustmentsCreate)
