/**
 * POST /api/v1/companies/{companyId}/fiscal-periods/{id}/opening-balances/correct:
 * correct a year's ingående balanser by storno (operation
 * opening-balances.correct).
 *
 * Contract, docs and rules in src/lib/operations/opening-balances.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { openingBalancesCorrect } from '@/lib/operations/opening-balances'

export const POST = v1OperationHandler(openingBalancesCorrect)
