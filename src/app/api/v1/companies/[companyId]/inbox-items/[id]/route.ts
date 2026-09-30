/**
 * /api/v1/companies/{companyId}/inbox-items/{id}: one inbox item.
 *
 * GET    : the item with its full reading (operation inbox-items.get).
 * PATCH  : correct fields of the reading (operation inbox-items.update-extracted-data).
 * DELETE : discard an item never converted or booked (operation inbox-items.delete).
 *
 * Contract, docs and rules live in src/lib/operations/inbox-items.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import {
  inboxItemsDelete,
  inboxItemsGet,
  inboxItemsUpdateExtractedData,
} from '@/lib/operations/inbox-items'

export const GET = v1OperationHandler(inboxItemsGet)
export const PATCH = v1OperationHandler(inboxItemsUpdateExtractedData)
export const DELETE = v1OperationHandler(inboxItemsDelete)
