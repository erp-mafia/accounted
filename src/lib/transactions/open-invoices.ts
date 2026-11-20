/**
 * The open invoices a bank line could settle: the plug-in point through which
 * the bank side asks the invoice blocks, so nothing under lib/transactions
 * imports them. Three questions, each asked where it was asked before:
 *   - ingest's pool of open customer invoices for one batch
 *     (IngestPools.customerInvoices, lib/transactions/ingest.ts),
 *   - the open invoice behind each part of a Bankgirot split
 *     (applyTransactionSplit, lib/transactions/parts-apply.ts),
 *   - before a plain booking on a receivables or payables account, the open
 *     invoices that already cover the line (categorizeTransaction's
 *     intercept, lib/transactions/categorize-core.ts).
 *
 * The invoice blocks answer in lib/invoices/bank-open-invoices.ts; the static
 * wiring the bank side imports is lib/composition/open-invoices.ts.
 *
 * Imports nothing at runtime: the blocks that answer depend on this file's
 * types only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import type { InvoiceMatchPool } from '@/lib/invoices/invoice-matching'
import type { InvoiceMatchSuggestion, InvoiceMatchSuggestionInput } from '@/lib/invoices/invoice-match-suggestion'
import type { PartSuggestion, PartSuggestionInput } from '@/lib/transactions/part-suggestions'

export interface OpenInvoices {
  /** The company's open customer invoices with their customer. Throws when the read fails. */
  loadCustomerInvoicePool(supabase: SupabaseClient, companyId: string): Promise<InvoiceMatchPool>
  /** One suggestion per part of a split, in the parts' order. Pure. */
  suggestSplitParts(input: PartSuggestionInput): PartSuggestion[]
  /**
   * The refusal (structured-error code and details) for a plain booking an
   * open invoice already covers, or null when it may proceed. Read-only.
   */
  findCategorizeInterception(
    supabase: SupabaseClient,
    companyId: string,
    input: InvoiceMatchSuggestionInput,
    log: Logger,
  ): Promise<InvoiceMatchSuggestion | null>
}
