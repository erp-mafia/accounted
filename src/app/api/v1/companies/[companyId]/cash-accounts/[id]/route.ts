/**
 * /api/v1/companies/{companyId}/cash-accounts/{id}: one bank/cash account.
 *
 * PATCH : edit voucher series, payee details, name or enabled
 *         (operation cash-accounts.update).
 *
 * Contract, docs and rules live in src/lib/operations/cash-accounts.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { cashAccountsUpdate } from '@/lib/operations/cash-accounts'

export const PATCH = v1OperationHandler(cashAccountsUpdate)
