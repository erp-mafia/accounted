/**
 * POST /api/v1/companies/{companyId}/spend/items/{itemId}/book (operation spend.item-book).
 *
 * Contract, docs and rules live in src/lib/operations/spend.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { spendItemBook } from '@/lib/operations/spend'

export const POST = v1OperationHandler(spendItemBook)
