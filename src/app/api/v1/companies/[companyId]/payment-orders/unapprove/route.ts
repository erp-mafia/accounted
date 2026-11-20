/**
 * POST /api/v1/companies/{companyId}/payment-orders/unapprove: approved bank
 * payments back to draft (operation payment-orders.unapprove).
 *
 * Contract, docs and rules live in src/lib/operations/payment-orders.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { paymentOrdersUnapprove } from '@/lib/operations/payment-orders'

export const POST = v1OperationHandler(paymentOrdersUnapprove)
