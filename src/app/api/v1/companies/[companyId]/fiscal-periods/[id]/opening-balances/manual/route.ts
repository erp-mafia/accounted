/**
 * POST /api/v1/companies/{companyId}/fiscal-periods/{id}/opening-balances/manual:
 * book a year's ingående balanser from explicit lines (operation
 * opening-balances.set-manual).
 *
 * Contract, docs and rules in src/lib/operations/opening-balances.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { openingBalancesSetManual } from '@/lib/operations/opening-balances'

export const POST = v1OperationHandler(openingBalancesSetManual)
