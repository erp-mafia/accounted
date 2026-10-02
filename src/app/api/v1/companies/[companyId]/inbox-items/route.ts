/**
 * GET /api/v1/companies/{companyId}/inbox-items: the invoice inbox
 * (operation inbox-items.list).
 *
 * Contract, docs and rules live in src/lib/operations/inbox-items.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { inboxItemsList } from '@/lib/operations/inbox-items'

export const GET = v1OperationHandler(inboxItemsList)
