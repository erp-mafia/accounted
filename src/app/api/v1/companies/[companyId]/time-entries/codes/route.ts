/**
 * /api/v1/companies/{companyId}/time-entries/codes: consultants, activity
 * codes, customer codes and projects a time entry can reference.
 *
 * GET : operation time-entries.codes.
 *
 * Contracts, docs and rules live in src/lib/operations/time-entries.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { timeEntriesCodes } from '@/lib/operations/time-entries'

export const GET = v1OperationHandler(timeEntriesCodes)
