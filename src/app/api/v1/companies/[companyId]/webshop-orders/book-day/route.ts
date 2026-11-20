/**
 * POST /api/v1/companies/{companyId}/webshop-orders/book-day (operation webshop-orders.book-day).
 *
 * Contract, docs and rules live in src/lib/operations/webshop-orders.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { webshopOrdersBookDay } from '@/lib/operations/webshop-orders'

export const POST = v1OperationHandler(webshopOrdersBookDay)
