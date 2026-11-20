/**
 * GET /api/v1/companies/{companyId}/deadlines (deadlines.list)
 *
 * Contract, docs and rules in src/lib/operations/deadlines.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { deadlinesList } from '@/lib/operations/deadlines'

export const GET = v1OperationHandler(deadlinesList)
