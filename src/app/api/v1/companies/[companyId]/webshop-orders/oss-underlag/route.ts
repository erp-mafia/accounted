/**
 * GET /api/v1/companies/{companyId}/webshop-orders/oss-underlag (operation webshop-orders.oss-underlag).
 *
 * Contract, docs and rules live in src/lib/operations/webshop-orders.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { webshopOrdersOssUnderlag } from '@/lib/operations/webshop-orders'

export const GET = v1OperationHandler(webshopOrdersOssUnderlag)
