/**
 * GET /api/v1/companies/{companyId}/reports/bokslutsbilagor (operation reports.bokslutsbilagor).
 *
 * Contract, docs and rules live in src/lib/operations/filing-reports.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { reportsBokslutsbilagor } from '@/lib/operations/filing-reports'

export const GET = v1OperationHandler(reportsBokslutsbilagor)
