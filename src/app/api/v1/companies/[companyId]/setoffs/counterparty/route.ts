/**
 * GET /api/v1/companies/{companyId}/setoffs/counterparty: a counterparty that
 * is both customer and supplier, with its open invoices, the net and its
 * set-offs (operation invoices.counterparty-balance.get,
 * src/lib/operations/counterparty-setoff.ts). Off unless
 * COUNTERPARTY_SETOFF_ENABLED.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { invoicesCounterpartyBalanceGet } from '@/lib/operations/counterparty-setoff'

export const GET = v1OperationHandler(invoicesCounterpartyBalanceGet)
