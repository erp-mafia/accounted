/**
 * GET /api/v1/companies/{companyId}/reports/dimension-pnl (operation reports.dimension-pnl).
 *
 * Contract, docs and rules live in src/lib/operations/filing-reports.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { reportsDimensionPnl } from '@/lib/operations/filing-reports'

export const GET = v1OperationHandler(reportsDimensionPnl)
