/**
 * POST /api/v1/companies/{companyId}/inbox-items/{id}/convert: register a
 * supplier invoice from an inbox item (operation
 * inbox-items.convert-to-supplier-invoice).
 *
 * Contract, docs and rules live in src/lib/operations/inbox-items.ts. The
 * conversion emits supplier_invoice.registered and .confirmed, so the event
 * bus is wired first.
 */
import { ensureInitialized } from '@/lib/init'
import { v1OperationHandler } from '@/lib/operations/v1'
import { inboxItemsConvertToSupplierInvoice } from '@/lib/operations/inbox-items'

ensureInitialized()

export const POST = v1OperationHandler(inboxItemsConvertToSupplierInvoice)
