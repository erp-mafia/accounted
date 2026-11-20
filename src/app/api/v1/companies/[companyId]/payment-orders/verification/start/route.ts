/**
 * POST /api/v1/companies/{companyId}/payment-orders/verification/start: start
 * the company's verification at the payment provider and answer the form link
 * a signatory fills in (operation payments.verification-start).
 *
 * Contract, docs and rules live in src/lib/operations/payment-orders.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { paymentsVerificationStart } from '@/lib/operations/payment-orders'

export const POST = v1OperationHandler(paymentsVerificationStart)
