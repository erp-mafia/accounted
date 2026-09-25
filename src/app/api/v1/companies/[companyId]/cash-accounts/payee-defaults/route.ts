/**
 * PUT /api/v1/companies/{companyId}/cash-accounts/payee-defaults: which bank
 * account invoices in a currency print as payee
 * (operation cash-accounts.set-payee-default).
 *
 * Contract, docs and rules live in src/lib/operations/cash-accounts.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { cashAccountsSetPayeeDefault } from '@/lib/operations/cash-accounts'

export const PUT = v1OperationHandler(cashAccountsSetPayeeDefault)
