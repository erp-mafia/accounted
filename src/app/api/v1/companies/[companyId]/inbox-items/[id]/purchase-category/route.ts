/**
 * PUT /api/v1/companies/{companyId}/inbox-items/{id}/purchase-category: set
 * or clear what an inbox item bought (operation
 * inbox-items.set-purchase-category).
 *
 * Contract, docs and rules live in src/lib/operations/inbox-purchase-category.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { inboxItemsSetPurchaseCategory } from '@/lib/operations/inbox-purchase-category'

export const PUT = v1OperationHandler(inboxItemsSetPurchaseCategory)
