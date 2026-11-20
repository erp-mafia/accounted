/**
 * GET /api/v1/companies/{companyId}/unexplained: the unexplained queue, every
 * expected-zero check run for the company (operation unexplained.list,
 * src/lib/operations/unexplained.ts).
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { unexplainedList } from '@/lib/operations/unexplained'

export const GET = v1OperationHandler(unexplainedList)
