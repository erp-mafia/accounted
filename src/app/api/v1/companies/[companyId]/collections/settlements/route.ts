/**
 * GET /api/v1/companies/{companyId}/collections/settlements (operation collections.settlements.list).
 *
 * Contract, docs and rules live in src/lib/operations/collections-booking.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { collectionsSettlementsList } from '@/lib/operations/collections-booking'

export const GET = v1OperationHandler(collectionsSettlementsList)
