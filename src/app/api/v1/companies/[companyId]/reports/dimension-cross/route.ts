/**
 * GET /api/v1/companies/{companyId}/reports/dimension-cross (operation reports.dimension-cross).
 *
 * Contract, docs and rules live in src/lib/operations/filing-reports.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { reportsDimensionCross } from '@/lib/operations/filing-reports'

export const GET = v1OperationHandler(reportsDimensionCross)
