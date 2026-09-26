/**
 * POST /api/v1/companies/{companyId}/invoices/bulk-book: book many customer
 * invoices, each with its own result (operation invoices.bulk-book).
 *
 * Contract, docs and rules live in src/lib/operations/invoice-booking.ts.
 * Drafts issued here emit invoice.sent, so the event bus is wired first.
 */
import { ensureInitialized } from '@/lib/init'
import { v1OperationHandler } from '@/lib/operations/v1'
import { invoicesBulkBook } from '@/lib/operations/invoice-booking'

ensureInitialized()

export const POST = v1OperationHandler(invoicesBulkBook)
