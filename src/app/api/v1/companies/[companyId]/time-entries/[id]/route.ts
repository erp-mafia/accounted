/**
 * /api/v1/companies/{companyId}/time-entries/{id}: one time entry.
 *
 * PATCH  : change an entry that is not invoiced (operation time-entries.update).
 * DELETE : delete an entry that is not invoiced (operation time-entries.delete).
 *
 * Contracts, docs and rules live in src/lib/operations/time-entries.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { timeEntriesDelete, timeEntriesUpdate } from '@/lib/operations/time-entries'

export const PATCH = v1OperationHandler(timeEntriesUpdate)
export const DELETE = v1OperationHandler(timeEntriesDelete)
