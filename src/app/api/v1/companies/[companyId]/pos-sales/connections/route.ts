/**
 * GET  /api/v1/companies/{companyId}/pos-sales/connections (operation pos-sales.connections-list).
 * POST /api/v1/companies/{companyId}/pos-sales/connections (operation pos-sales.connect).
 *
 * Contract, docs and rules live in src/lib/operations/pos-sales.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { posSalesConnect, posSalesConnectionsList } from '@/lib/operations/pos-sales'

export const GET = v1OperationHandler(posSalesConnectionsList)
export const POST = v1OperationHandler(posSalesConnect)
