/**
 * GET /api/v1/companies/{companyId}/invoices/late-payment-interest:
 * dröjsmålsränta per customer invoice (operation
 * invoices.late-payment-interest.get).
 *
 * Contract, docs and rules live in src/lib/operations/late-payment-interest.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { invoicesLatePaymentInterestGet } from '@/lib/operations/late-payment-interest'

export const GET = v1OperationHandler(invoicesLatePaymentInterestGet)
