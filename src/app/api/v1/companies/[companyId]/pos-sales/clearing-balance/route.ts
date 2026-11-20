/**
 * GET /api/v1/companies/{companyId}/pos-sales/clearing-balance (operation pos-sales.clearing-balance).
 *
 * Contract, docs and rules live in src/lib/operations/pos-sales.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { posSalesClearingBalance } from '@/lib/operations/pos-sales'

export const GET = v1OperationHandler(posSalesClearingBalance)
