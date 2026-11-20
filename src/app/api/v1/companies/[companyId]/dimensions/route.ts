/**
 * /api/v1/companies/{companyId}/dimensions: the dimension registry.
 *
 * GET  : list dimensions with their values (operation dimensions.list).
 * POST : create a custom dimension (operation dimensions.create).
 *
 * Contracts, docs and rules live in src/lib/operations/dimensions.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { dimensionsCreate, dimensionsList } from '@/lib/operations/dimensions'

export const GET = v1OperationHandler(dimensionsList)
export const POST = v1OperationHandler(dimensionsCreate)
