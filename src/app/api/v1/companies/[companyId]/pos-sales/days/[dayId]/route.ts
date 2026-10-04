/**
 * GET /api/v1/companies/{companyId}/pos-sales/days/{dayId} (operation pos-sales.day-get).
 *
 * Contract, docs and rules live in src/lib/operations/pos-sales.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { posSalesDayGet } from '@/lib/operations/pos-sales'

export const GET = v1OperationHandler(posSalesDayGet)
