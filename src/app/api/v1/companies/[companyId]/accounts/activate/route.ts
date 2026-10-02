/**
 * POST /api/v1/companies/{companyId}/accounts/activate: activate BAS
 * accounts in bulk (operation accounts.activate).
 *
 * Contract, docs and rules live in src/lib/operations/accounts.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { accountsActivate } from '@/lib/operations/accounts'

export const POST = v1OperationHandler(accountsActivate)
