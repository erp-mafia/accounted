/**
 * POST /api/v1/companies/{companyId}/payment-orders/approve: attest draft bank
 * payments (operation payment-orders.approve). Signing stays in the app.
 *
 * Contract, docs and rules live in src/lib/operations/payment-orders.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { paymentOrdersApprove } from '@/lib/operations/payment-orders'

export const POST = v1OperationHandler(paymentOrdersApprove)
