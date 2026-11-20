/**
 * GET  /api/v1/companies/{companyId}/mileage-trips: list the körjournal
 * (operation mileage-trips.list).
 * POST /api/v1/companies/{companyId}/mileage-trips: log a trip as a draft
 * (operation mileage-trips.create).
 *
 * Contracts, docs and rules in src/lib/operations/mileage-trips.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { mileageTripsCreate, mileageTripsList } from '@/lib/operations/mileage-trips'

export const GET = v1OperationHandler(mileageTripsList)
export const POST = v1OperationHandler(mileageTripsCreate)
