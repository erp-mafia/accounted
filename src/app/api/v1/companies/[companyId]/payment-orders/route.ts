/**
 * /api/v1/companies/{companyId}/payment-orders: bank payments (betalningar via
 * banken) for supplier invoices.
 *
 * GET  : list orders, newest first (operation payment-orders.list).
 * POST : prepare draft orders (operation payment-orders.prepare). Nothing
 *        reaches the bank: a person approves and signs with BankID in Accounted.
 *
 * Contract, docs and rules live in src/lib/operations/payment-orders.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { paymentOrdersList, paymentOrdersPrepare } from '@/lib/operations/payment-orders'

export const GET = v1OperationHandler(paymentOrdersList)
export const POST = v1OperationHandler(paymentOrdersPrepare)
