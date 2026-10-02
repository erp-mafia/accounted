/**
 * POST /api/v1/companies/{companyId}/transactions/{id}/refresh-exchange-rate:
 * fill in the Riksbanken rate of an unbooked foreign-currency transaction
 * (operation transactions.refresh-exchange-rate).
 *
 * Contract, docs and rules in src/lib/operations/transactions.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { transactionsRefreshExchangeRate } from '@/lib/operations/transactions'

export const POST = v1OperationHandler(transactionsRefreshExchangeRate)
