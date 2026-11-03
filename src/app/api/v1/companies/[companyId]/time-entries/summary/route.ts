/**
 * /api/v1/companies/{companyId}/time-entries/summary: hours and uninvoiced
 * amounts per customer, project or consultant and month.
 *
 * GET : operation time-entries.summary.
 *
 * Contracts, docs and rules live in src/lib/operations/time-entries.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { timeEntriesSummary } from '@/lib/operations/time-entries'

export const GET = v1OperationHandler(timeEntriesSummary)
