/**
 * POST /api/v1/companies/{companyId}/deadlines/{id}/complete (deadlines.complete:
 *      ticks a deadline off, or puts it back with is_completed false)
 *
 * Contract, docs and rules in src/lib/operations/deadlines.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { deadlinesComplete } from '@/lib/operations/deadlines'

export const POST = v1OperationHandler(deadlinesComplete)
