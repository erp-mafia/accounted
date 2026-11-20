/**
 * GET /api/v1/companies/{companyId}/payment-orders/verification: the company's
 * verification (know your customer) at the payment provider (operation
 * payments.verification).
 *
 * Contract, docs and rules live in src/lib/operations/payment-orders.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { paymentsVerification } from '@/lib/operations/payment-orders'

export const GET = v1OperationHandler(paymentsVerification)
