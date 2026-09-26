/**
 * /api/v1/companies/{companyId}/fiscal-periods/{id}: one räkenskapsår.
 *
 * PATCH : rename or re-date an open, unlocked year (operation fiscal-periods.update).
 *
 * Contracts, docs and rules live in src/lib/operations/fiscal-periods.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { fiscalPeriodsUpdate } from '@/lib/operations/fiscal-periods'

export const PATCH = v1OperationHandler(fiscalPeriodsUpdate)
