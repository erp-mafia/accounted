/**
 * POST /api/v1/companies/{companyId}/cash-accounts/{id}/set-primary: make the
 * account the company's primary (operation cash-accounts.set-primary).
 *
 * Contract, docs and rules live in src/lib/operations/cash-accounts.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { cashAccountsSetPrimary } from '@/lib/operations/cash-accounts'

export const POST = v1OperationHandler(cashAccountsSetPrimary)
