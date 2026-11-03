/**
 * /api/v1/companies/{companyId}/time-entries: registered hours.
 *
 * GET  : list time entries, newest first (operation time-entries.list).
 * POST : register 1-20 entries (operation time-entries.create).
 *
 * Contracts, docs and rules live in src/lib/operations/time-entries.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { timeEntriesCreate, timeEntriesList } from '@/lib/operations/time-entries'

export const GET = v1OperationHandler(timeEntriesList)
export const POST = v1OperationHandler(timeEntriesCreate)
