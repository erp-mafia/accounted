/**
 * GET /api/v1/companies/{companyId}/reports/ink3 (operation reports.ink3).
 *
 * Contract, docs and rules live in src/lib/operations/filing-reports.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { reportsInk3 } from '@/lib/operations/filing-reports'

export const GET = v1OperationHandler(reportsInk3)
