/**
 * GET /api/v1/companies/{companyId}/dimensions/retag-log: the history of
 * dimension tag changes on posted lines (operation dimensions.retag-log).
 *
 * Contract, docs and rules live in src/lib/operations/dimension-retag.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { dimensionsRetagLog } from '@/lib/operations/dimension-retag'

export const GET = v1OperationHandler(dimensionsRetagLog)
