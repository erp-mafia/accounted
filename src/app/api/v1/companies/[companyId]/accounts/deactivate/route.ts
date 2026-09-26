/**
 * POST /api/v1/companies/{companyId}/accounts/deactivate: deactivate
 * accounts in bulk (operation accounts.deactivate).
 *
 * Contract, docs and rules live in src/lib/operations/accounts.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { accountsDeactivate } from '@/lib/operations/accounts'

export const POST = v1OperationHandler(accountsDeactivate)
