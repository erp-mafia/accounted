/**
 * GET /api/v1/companies/{companyId}/payment-orders/{id}: one bank payment
 * order (operation payment-orders.get).
 *
 * Contract, docs and rules live in src/lib/operations/payment-orders.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { paymentOrdersGet } from '@/lib/operations/payment-orders'

export const GET = v1OperationHandler(paymentOrdersGet)
