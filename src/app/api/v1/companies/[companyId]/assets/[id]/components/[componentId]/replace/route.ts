/**
 * POST /api/v1/companies/{companyId}/assets/{id}/components/{componentId}/replace: a K3 component replaced
 * (operation assets.components.replace).
 *
 * Contract, docs and rules live in src/lib/operations/k3.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { assetsComponentsReplace } from '@/lib/operations/k3'

export const POST = v1OperationHandler(assetsComponentsReplace)
