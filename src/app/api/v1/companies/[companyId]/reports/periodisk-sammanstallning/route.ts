/**
 * GET /api/v1/companies/{companyId}/reports/periodisk-sammanstallning (operation reports.periodisk-sammanstallning).
 *
 * Contract, docs and rules live in src/lib/operations/filing-reports.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { reportsPeriodiskSammanstallning } from '@/lib/operations/filing-reports'

export const GET = v1OperationHandler(reportsPeriodiskSammanstallning)
