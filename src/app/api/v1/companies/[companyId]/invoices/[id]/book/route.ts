/**
 * POST /api/v1/companies/{companyId}/invoices/{id}/book: the deferred
 * "Bokför" step for a sent customer invoice issued without a verifikat
 * (operation invoices.book).
 *
 * Contract, docs and rules live in src/lib/operations/invoice-booking.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { invoicesBook } from '@/lib/operations/invoice-booking'

export const POST = v1OperationHandler(invoicesBook)
