/**
 * POST /api/v1/companies/{companyId}/inbox-items/{id}/match-transaction: pair
 * an inbox item with a bank transaction (operation
 * inbox-items.match-transaction).
 *
 * Contract, docs and rules live in src/lib/operations/inbox-matches.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { inboxItemsMatchTransaction } from '@/lib/operations/inbox-matches'

export const POST = v1OperationHandler(inboxItemsMatchTransaction)
