/**
 * GET /api/v1/companies/{companyId}/spend/items/{itemId} (operation spend.item-get).
 *
 * Contract, docs and rules live in src/lib/operations/spend.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { spendItemGet } from '@/lib/operations/spend'

export const GET = v1OperationHandler(spendItemGet)
