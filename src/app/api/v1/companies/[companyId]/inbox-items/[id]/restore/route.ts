/**
 * POST /api/v1/companies/{companyId}/inbox-items/{id}/restore: put a deleted
 * inbox item back in the inbox, as it was deleted (operation
 * inbox-items.restore).
 *
 * Contract, docs and rules live in src/lib/operations/inbox-items.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { inboxItemsRestore } from '@/lib/operations/inbox-items'

export const POST = v1OperationHandler(inboxItemsRestore)
