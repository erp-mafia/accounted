/**
 * POST /api/v1/companies/{companyId}/cash-accounts/change-ledgers: move
 * bank-connected accounts to other 19xx ledger accounts (operation
 * cash-accounts.change-ledgers, crm#1663).
 *
 * Contract, docs and rules live in src/lib/operations/cash-accounts.ts and
 * src/lib/cash-accounts/ledger-change.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { cashAccountsChangeLedgers } from '@/lib/operations/cash-accounts'

export const POST = v1OperationHandler(cashAccountsChangeLedgers)
