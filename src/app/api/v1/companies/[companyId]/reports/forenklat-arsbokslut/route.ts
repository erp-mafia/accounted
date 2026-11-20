/**
 * GET /api/v1/companies/{companyId}/reports/forenklat-arsbokslut (operation
 * reports.forenklat-arsbokslut).
 *
 * Contract, docs and rules live in src/lib/operations/forenklat-arsbokslut.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { reportsForenklatArsbokslut } from '@/lib/operations/forenklat-arsbokslut'

export const GET = v1OperationHandler(reportsForenklatArsbokslut)
