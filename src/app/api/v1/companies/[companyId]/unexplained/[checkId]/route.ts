/**
 * GET /api/v1/companies/{companyId}/unexplained/{checkId}: one expected-zero
 * check with its definition, basis, compared figures and every result
 * (operation unexplained.get, src/lib/operations/unexplained.ts).
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { unexplainedGet } from '@/lib/operations/unexplained'

export const GET = v1OperationHandler(unexplainedGet)
