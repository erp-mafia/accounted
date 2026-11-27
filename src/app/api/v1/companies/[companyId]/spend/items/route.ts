/**
 * GET /api/v1/companies/{companyId}/spend/items (operation spend.items-list).
 *
 * Contract, docs and rules live in src/lib/operations/spend.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { spendItemsList } from '@/lib/operations/spend'

export const GET = v1OperationHandler(spendItemsList)
