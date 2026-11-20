/**
 * POST /api/v1/companies/{companyId}/setoffs: set off an open customer invoice
 * against an open supplier invoice of the same counterparty (operation
 * invoices.setoff.book, src/lib/operations/counterparty-setoff.ts). Off unless
 * COUNTERPARTY_SETOFF_ENABLED.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { invoicesSetoffBook } from '@/lib/operations/counterparty-setoff'

export const POST = v1OperationHandler(invoicesSetoffBook)
