/**
 * POST /api/v1/companies/{companyId}/collections/settlements/{settlementId}/book (operation collections.settlements.book).
 *
 * Contract, docs and rules live in src/lib/operations/collections-booking.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { collectionsSettlementsBook } from '@/lib/operations/collections-booking'

export const POST = v1OperationHandler(collectionsSettlementsBook)
