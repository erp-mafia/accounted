/**
 * GET /api/v1/companies/{companyId}/webshop-orders (operation webshop-orders.list).
 *
 * Contract, docs and rules live in src/lib/operations/webshop-orders.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { webshopOrdersList } from '@/lib/operations/webshop-orders'

export const GET = v1OperationHandler(webshopOrdersList)
