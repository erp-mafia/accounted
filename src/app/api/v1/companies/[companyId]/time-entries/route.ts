/**
 * /api/v1/companies/{companyId}/time-entries: registered hours.
 *
 * GET : list time entries, newest first (operation time-entries.list).
 *
 * Contracts, docs and rules live in src/lib/operations/time-entries.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { timeEntriesList } from '@/lib/operations/time-entries'

export const GET = v1OperationHandler(timeEntriesList)
