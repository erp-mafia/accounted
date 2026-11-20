/**
 * /api/v1/companies/{companyId}/supplier-payment-batches: supplier payment
 * files (betalfil, pain.001).
 *
 * GET  : list batches, newest first (operation supplier-payment-batches.list).
 * POST : create a batch (operation supplier-payment-batches.create).
 *
 * Contract, docs and rules live in src/lib/operations/supplier-payment-batches.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { supplierPaymentBatchesCreate, supplierPaymentBatchesList } from '@/lib/operations/supplier-payment-batches'

export const GET = v1OperationHandler(supplierPaymentBatchesList)
export const POST = v1OperationHandler(supplierPaymentBatchesCreate)
