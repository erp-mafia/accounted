/**
 * GET /api/v1/companies/{companyId}/webshop-orders/{orderId} (operation webshop-orders.get).
 *
 * Contract, docs and rules live in src/lib/operations/webshop-orders.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { webshopOrdersGet } from '@/lib/operations/webshop-orders'

export const GET = v1OperationHandler(webshopOrdersGet)
