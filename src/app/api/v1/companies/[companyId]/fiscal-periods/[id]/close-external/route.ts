/**
 * POST /api/v1/companies/{companyId}/fiscal-periods/{id}/close-external
 *
 * Klarmarkera: mark a migrated räkenskapsår as closed in the previous
 * bookkeeping system (operation fiscal-periods.close-external). Contract,
 * docs and rules live in src/lib/operations/fiscal-periods.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { fiscalPeriodsCloseExternal } from '@/lib/operations/fiscal-periods'

export const POST = v1OperationHandler(fiscalPeriodsCloseExternal)
