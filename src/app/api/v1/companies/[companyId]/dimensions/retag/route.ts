/**
 * POST /api/v1/companies/{companyId}/dimensions/retag: change the dimension
 * tags on posted journal lines (operation dimensions.retag-lines), merging
 * into each line's tags by default.
 *
 * Contract, docs and rules live in src/lib/operations/dimension-retag.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { dimensionsRetagLines } from '@/lib/operations/dimension-retag'

export const POST = v1OperationHandler(dimensionsRetagLines)
