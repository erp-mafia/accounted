/**
 * GET /api/v1/companies/{companyId}/reports/ne-bilaga (operation reports.ne-bilaga).
 *
 * Contract, docs and rules live in src/lib/operations/filing-reports.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { reportsNeBilaga } from '@/lib/operations/filing-reports'

export const GET = v1OperationHandler(reportsNeBilaga)
