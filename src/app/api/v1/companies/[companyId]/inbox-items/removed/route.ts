/**
 * GET /api/v1/companies/{companyId}/inbox-items/removed: the inbox items
 * deleted most recently that can still be put back (operation
 * inbox-items.list-removed).
 *
 * Contract, docs and rules live in src/lib/operations/inbox-items.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { inboxItemsListRemoved } from '@/lib/operations/inbox-items'

export const GET = v1OperationHandler(inboxItemsListRemoved)
