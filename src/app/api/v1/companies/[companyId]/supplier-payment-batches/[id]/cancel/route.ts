/**
 * POST /api/v1/companies/{companyId}/supplier-payment-batches/{id}/cancel:
 * makulera a batch (operation supplier-payment-batches.cancel).
 *
 * Contract, docs and rules live in src/lib/operations/supplier-payment-batches.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { supplierPaymentBatchesCancel } from '@/lib/operations/supplier-payment-batches'

export const POST = v1OperationHandler(supplierPaymentBatchesCancel)
