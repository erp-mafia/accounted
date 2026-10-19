/**
 * The invoice blocks' answer to the bank side's open-invoice questions
 * (contract: lib/transactions/open-invoices.ts; wiring:
 * lib/composition/open-invoices.ts). Each member calls the function the bank
 * side called directly before, with the same arguments.
 */
import type { OpenInvoices } from '@/lib/transactions/open-invoices'
import { loadInvoiceMatchPool } from '@/lib/invoices/invoice-matching'
import { suggestPartInvoices } from '@/lib/invoices/part-invoice-suggestions'
import { findInvoiceMatchSuggestion } from '@/lib/invoices/invoice-match-suggestion'

export const bankOpenInvoices: OpenInvoices = Object.freeze<OpenInvoices>({
  loadCustomerInvoicePool: (supabase, companyId) => loadInvoiceMatchPool(supabase, companyId),
  suggestSplitParts: (input) => suggestPartInvoices(input),
  findCategorizeInterception: (supabase, companyId, input, log) =>
    findInvoiceMatchSuggestion(supabase, companyId, input, log),
})
