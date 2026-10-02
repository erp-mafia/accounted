/**
 * GET /api/v1/companies/{companyId}/supplier-payment-batches/{id}: one batch
 * with its lines and live settlement (operation supplier-payment-batches.get).
 *
 * Contract, docs and rules live in src/lib/operations/supplier-payment-batches.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { supplierPaymentBatchesGet } from '@/lib/operations/supplier-payment-batches'

export const GET = v1OperationHandler(supplierPaymentBatchesGet)
