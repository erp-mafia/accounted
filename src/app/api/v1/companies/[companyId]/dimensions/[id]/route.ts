/**
 * /api/v1/companies/{companyId}/dimensions/{id}: one dimension.
 *
 * PATCH  : rename, archive or reorder (operation dimensions.update).
 * DELETE : delete a custom dimension nothing is booked on (dimensions.delete).
 *
 * Contracts, docs and rules live in src/lib/operations/dimensions.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { dimensionsDelete, dimensionsUpdate } from '@/lib/operations/dimensions'

export const PATCH = v1OperationHandler(dimensionsUpdate)
export const DELETE = v1OperationHandler(dimensionsDelete)
