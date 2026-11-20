/**
 * POST /api/v1/companies/{companyId}/inbox-items/{id}/match-supplier: set the
 * supplier an inbox item comes from (operation inbox-items.match-supplier).
 *
 * Contract, docs and rules live in src/lib/operations/inbox-matches.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { inboxItemsMatchSupplier } from '@/lib/operations/inbox-matches'

export const POST = v1OperationHandler(inboxItemsMatchSupplier)
