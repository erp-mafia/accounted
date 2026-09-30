/**
 * POST /api/v1/companies/{companyId}/inbox-items/{id}/unmatch-transaction:
 * release an inbox item's bank transaction match (operation
 * inbox-items.unmatch-transaction).
 *
 * Contract, docs and rules live in src/lib/operations/inbox-items.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { inboxItemsUnmatchTransaction } from '@/lib/operations/inbox-items'

export const POST = v1OperationHandler(inboxItemsUnmatchTransaction)
