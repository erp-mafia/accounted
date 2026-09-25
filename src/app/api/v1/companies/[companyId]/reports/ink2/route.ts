/**
 * GET /api/v1/companies/{companyId}/reports/ink2 (operation reports.ink2).
 *
 * Contract, docs and rules live in src/lib/operations/filing-reports.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { reportsInk2 } from '@/lib/operations/filing-reports'

export const GET = v1OperationHandler(reportsInk2)
