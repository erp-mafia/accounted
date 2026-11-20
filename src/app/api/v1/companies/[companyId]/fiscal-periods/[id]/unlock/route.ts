/**
 * POST /api/v1/companies/{companyId}/fiscal-periods/{id}/unlock
 *
 * Unlock a locked, not closed, räkenskapsår (operation fiscal-periods.unlock).
 * Contract, docs and rules live in src/lib/operations/fiscal-periods.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { fiscalPeriodsUnlock } from '@/lib/operations/fiscal-periods'

export const POST = v1OperationHandler(fiscalPeriodsUnlock)
