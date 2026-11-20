/**
 * PUT /api/v1/companies/{companyId}/assets/{id}/tax-plan: a building's tax depreciation plan
 * (operation assets.tax-plan.set).
 *
 * Contract, docs and rules live in src/lib/operations/k3.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { assetsTaxPlanSet } from '@/lib/operations/k3'

export const PUT = v1OperationHandler(assetsTaxPlanSet)
