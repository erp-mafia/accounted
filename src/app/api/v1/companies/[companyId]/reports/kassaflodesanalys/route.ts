/**
 * GET /api/v1/companies/{companyId}/reports/kassaflodesanalys (operation reports.kassaflodesanalys).
 *
 * Contract, docs and rules live in src/lib/operations/filing-reports.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { reportsKassaflodesanalys } from '@/lib/operations/filing-reports'

export const GET = v1OperationHandler(reportsKassaflodesanalys)
