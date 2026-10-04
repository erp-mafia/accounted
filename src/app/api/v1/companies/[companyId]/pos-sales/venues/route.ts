/**
 * GET /api/v1/companies/{companyId}/pos-sales/venues (operation pos-sales.venues-list).
 *
 * Contract, docs and rules live in src/lib/operations/pos-sales.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { posSalesVenuesList } from '@/lib/operations/pos-sales'

export const GET = v1OperationHandler(posSalesVenuesList)
