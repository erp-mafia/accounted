/**
 * GET /api/v1/companies/{companyId}/payment-orders/usage: bank payments sent
 * and accounts used in a month, against what the plan includes (operation
 * payments.usage).
 *
 * Contract, docs and rules live in src/lib/operations/payment-orders.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { paymentsUsage } from '@/lib/operations/payment-orders'

export const GET = v1OperationHandler(paymentsUsage)
