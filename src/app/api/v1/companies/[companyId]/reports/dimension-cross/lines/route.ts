/**
 * GET /api/v1/companies/{companyId}/reports/dimension-cross/lines (operation reports.dimension-cross-lines).
 *
 * Contract, docs and rules live in src/lib/operations/filing-reports.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { reportsDimensionCrossLines } from '@/lib/operations/filing-reports'

export const GET = v1OperationHandler(reportsDimensionCrossLines)
