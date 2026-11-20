/**
 * POST /api/v1/companies/{companyId}/collections/payments/{paymentId}/book (operation collections.payments.book).
 *
 * Contract, docs and rules live in src/lib/operations/collections-booking.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { collectionsPaymentsBook } from '@/lib/operations/collections-booking'

export const POST = v1OperationHandler(collectionsPaymentsBook)
