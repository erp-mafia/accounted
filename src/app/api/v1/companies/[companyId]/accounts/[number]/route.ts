/**
 * /api/v1/companies/{companyId}/accounts/{number}: one kontoplan account.
 *
 * PATCH  : edit or deactivate it (operation accounts.update).
 * DELETE : delete an account nothing is booked on (operation accounts.delete).
 *
 * Contracts, docs and rules live in src/lib/operations/accounts.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { accountsDelete, accountsUpdate } from '@/lib/operations/accounts'

export const PATCH = v1OperationHandler(accountsUpdate)
export const DELETE = v1OperationHandler(accountsDelete)
