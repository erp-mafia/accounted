/**
 * POST /api/v1/companies/{companyId}/pos-sales/fetch (operation pos-sales.fetch).
 *
 * Contract, docs and rules live in src/lib/operations/pos-sales.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { posSalesFetch } from '@/lib/operations/pos-sales'

// A fetch can run for up to six provider calls.
export const maxDuration = 300

export const POST = v1OperationHandler(posSalesFetch)
