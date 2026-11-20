/**
 * POST /api/v1/companies/{companyId}/webshop-orders/{orderId}/book (operation webshop-orders.book).
 *
 * Contract, docs and rules live in src/lib/operations/webshop-orders.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { webshopOrdersBook } from '@/lib/operations/webshop-orders'

export const POST = v1OperationHandler(webshopOrdersBook)
