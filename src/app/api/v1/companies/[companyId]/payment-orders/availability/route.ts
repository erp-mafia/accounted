/**
 * GET /api/v1/companies/{companyId}/payment-orders/availability: can the
 * company pay through its bank, and from which accounts (operation
 * payments.availability).
 *
 * Contract, docs and rules live in src/lib/operations/payment-orders.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { paymentsAvailability } from '@/lib/operations/payment-orders'

export const GET = v1OperationHandler(paymentsAvailability)
