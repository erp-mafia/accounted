/**
 * POST /api/v1/companies/{companyId}/spend/fetch (operation spend.fetch).
 *
 * Contract, docs and rules live in src/lib/operations/spend.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { spendFetch } from '@/lib/operations/spend'

export const POST = v1OperationHandler(spendFetch)
