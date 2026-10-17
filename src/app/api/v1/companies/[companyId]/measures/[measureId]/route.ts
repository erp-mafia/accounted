/**
 * GET /api/v1/companies/{companyId}/measures/{measureId}: one defined
 * figure, equal to its report, with its definition, as-of date, caveats and
 * an explain handle (operation measures.get, src/lib/operations/measures.ts).
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { measuresGet } from '@/lib/operations/measures'

export const GET = v1OperationHandler(measuresGet)
