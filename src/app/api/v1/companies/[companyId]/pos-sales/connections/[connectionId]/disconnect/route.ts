/**
 * POST /api/v1/companies/{companyId}/pos-sales/connections/{connectionId}/disconnect (operation pos-sales.disconnect).
 *
 * Contract, docs and rules live in src/lib/operations/pos-sales.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { posSalesDisconnect } from '@/lib/operations/pos-sales'

export const POST = v1OperationHandler(posSalesDisconnect)
