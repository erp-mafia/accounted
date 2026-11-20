/**
 * The open invoices a bank line could settle, as the bank side asks for them
 * (contract: lib/transactions/open-invoices.ts): ingest's customer invoice
 * pool, a split's part suggestions and categorize's invoice-match intercept.
 * Written out by hand and imported statically by those three doors: no lazy
 * registration, no lib/init, no event bus. The answer lives with the invoice
 * blocks.
 */
import type { OpenInvoices } from '@/lib/transactions/open-invoices'
import { bankOpenInvoices } from '@/lib/invoices/bank-open-invoices'

export const OPEN_INVOICES: OpenInvoices = bankOpenInvoices
