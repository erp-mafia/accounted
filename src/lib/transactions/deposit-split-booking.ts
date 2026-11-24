/**
 * Booking a Bankgirot deposit split without a person: the plug-in point
 * through which ingest (lib/transactions/ingest.ts) asks the invoice blocks,
 * so nothing under lib/transactions imports them. Asked once a split explains
 * its row (splitIsComplete), for a company that switched
 * auto_book_customer_payments on (crm#2226).
 *
 * The invoice blocks answer in lib/invoices/customer-payment-auto-book.ts;
 * the static wiring ingest imports is lib/composition/deposit-split-booking.ts.
 *
 * Imports nothing at runtime: the blocks that answer depend on this file's
 * types only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { InvoiceMatchPool } from '@/lib/invoices/invoice-matching'
import type { SplitAllocation, SplitAutoBookResult } from '@/lib/invoices/customer-payment-auto-book'
import type { OperationContext } from '@/lib/operations/types'
import type { PartSuggestion } from '@/lib/transactions/part-suggestions'
import type { BankTransactionPartInput } from '@/types'

export interface DepositSplitBooking {
  /** The company's auto_book_customer_payments switch; off when it cannot be read. */
  isOn(supabase: SupabaseClient, companyId: string): Promise<boolean>
  /**
   * The allocations of a complete split whose every part names its invoice
   * by OCR, or null when the split stays a suggestion. Pure.
   */
  allocations(
    parts: readonly BankTransactionPartInput[],
    suggestions: readonly PartSuggestion[],
    invoices: InvoiceMatchPool['invoices'],
  ): SplitAllocation[] | null
  /** Book them as one samlingsverifikat nobody confirmed; a refusal books nothing. */
  book(ctx: OperationContext, transactionId: string, allocations: readonly SplitAllocation[]): Promise<SplitAutoBookResult>
}
