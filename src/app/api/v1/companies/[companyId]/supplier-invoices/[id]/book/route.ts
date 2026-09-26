/**
 * POST /api/v1/companies/{companyId}/supplier-invoices/{id}/book: the
 * deferred "Bokför" step for a supplier invoice registered without a
 * verifikat (operation supplier-invoices.book).
 *
 * Contract, docs and rules live in src/lib/operations/invoice-booking.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { supplierInvoicesBook } from '@/lib/operations/invoice-booking'

export const POST = v1OperationHandler(supplierInvoicesBook)
