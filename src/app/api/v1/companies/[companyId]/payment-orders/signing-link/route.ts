/**
 * GET /api/v1/companies/{companyId}/payment-orders/signing-link: the
 * Betalningar page where a person approves and signs bank payments with
 * BankID, with what waits there (operation payments.signing-link).
 *
 * Contract, docs and rules live in src/lib/operations/payment-orders.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { paymentsSigningLink } from '@/lib/operations/payment-orders'

export const GET = v1OperationHandler(paymentsSigningLink)
