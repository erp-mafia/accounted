/**
 * GET /api/v1/companies/{companyId}/reports/kpi (operation reports.kpi).
 *
 * Contract, docs and rules live in src/lib/operations/filing-reports.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { reportsKpi } from '@/lib/operations/filing-reports'

export const GET = v1OperationHandler(reportsKpi)
