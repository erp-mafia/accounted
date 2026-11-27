/**
 * GET /api/v1/companies/{companyId}/spend/connections (operation spend.connections-list).
 *
 * Contract, docs and rules live in src/lib/operations/spend.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { spendConnectionsList } from '@/lib/operations/spend'

export const GET = v1OperationHandler(spendConnectionsList)
