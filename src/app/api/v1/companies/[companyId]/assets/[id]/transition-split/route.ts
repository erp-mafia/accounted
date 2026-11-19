/**
 * PUT /api/v1/companies/{companyId}/assets/{id}/transition-split: the split at the transition to K3
 * (operation assets.transition-split.set).
 *
 * Contract, docs and rules live in src/lib/operations/k3.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { assetsTransitionSplitSet } from '@/lib/operations/k3'

export const PUT = v1OperationHandler(assetsTransitionSplitSet)
