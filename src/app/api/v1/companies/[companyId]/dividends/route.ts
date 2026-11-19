/**
 * POST /api/v1/companies/{companyId}/dividends: record a dividend the
 * stämma decided and split it per holder (operation dividends.create).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget-capital.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { dividendsCreate } from '@/lib/operations/bolaget-capital'

export const POST = v1OperationHandler(dividendsCreate)
