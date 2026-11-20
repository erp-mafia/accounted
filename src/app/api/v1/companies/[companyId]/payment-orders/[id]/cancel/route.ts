/**
 * POST /api/v1/companies/{companyId}/payment-orders/{id}/cancel: cancel a bank
 * payment order (operation payment-orders.cancel). After the bank has the
 * payment, the order is cancelled only when the bank confirms.
 *
 * Contract, docs and rules live in src/lib/operations/payment-orders.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { paymentOrdersCancel } from '@/lib/operations/payment-orders'

export const POST = v1OperationHandler(paymentOrdersCancel)
