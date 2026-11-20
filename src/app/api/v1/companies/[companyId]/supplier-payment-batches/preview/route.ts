/**
 * POST /api/v1/companies/{companyId}/supplier-payment-batches/preview: which
 * supplier invoices can go into a payment file, and what blocks the rest
 * (operation supplier-payment-batches.preview; reads only).
 *
 * Contract, docs and rules live in src/lib/operations/supplier-payment-batches.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { supplierPaymentBatchesPreview } from '@/lib/operations/supplier-payment-batches'

export const POST = v1OperationHandler(supplierPaymentBatchesPreview)
