/**
 * POST /api/v1/companies/{companyId}/spend/connections/{connectionId}/disconnect (operation spend.disconnect).
 *
 * Contract, docs and rules live in src/lib/operations/spend.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { spendDisconnect } from '@/lib/operations/spend'

export const POST = v1OperationHandler(spendDisconnect)
