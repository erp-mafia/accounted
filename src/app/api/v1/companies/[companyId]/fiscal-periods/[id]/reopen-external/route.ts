/**
 * POST /api/v1/companies/{companyId}/fiscal-periods/{id}/reopen-external
 *
 * Undo klarmarkera: reopen a räkenskapsår marked closed in the previous
 * system (operation fiscal-periods.reopen-external). Contract, docs and rules
 * live in src/lib/operations/fiscal-periods.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { fiscalPeriodsReopenExternal } from '@/lib/operations/fiscal-periods'

export const POST = v1OperationHandler(fiscalPeriodsReopenExternal)
