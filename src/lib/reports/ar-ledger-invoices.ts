import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import type { CreditNoteLink } from './credit-note-settlement'
import type { PayoutItemFact } from '@/lib/bookkeeping/skatteverket-share'

/**
 * The kundreskontra population in one read: get_ar_ledger_invoices
 * (supabase/migrations/20261023093950_ar_ledger_invoices_rpc.sql).
 *
 * The AR ledger, its 1510/1513 reconciliation and the customer drill-down
 * used to page `invoices` 1 000 rows per round trip, then the company's
 * payment rows, then the credit notes' set-offs and the ROT/RUT begäran items
 * in `.in()` chunks. The function returns each invoice with those facts
 * attached; the rules that turn them into figures stay in TypeScript
 * (reskontra-payments.ts, credit-note-settlement.ts, skatteverket-share.ts),
 * so each rule keeps one definition.
 *
 * What the population leaves out, and the order it comes in, are documented
 * in the migration: settled credit notes, invoices written off by the as-of
 * date, and paid invoices provably settled by it are not returned, and the
 * rows come grouped per customer in the order an id-ordered walk of the
 * whole population first meets each customer.
 */

/** The verifikat an invoice was booked by (drill-down reads only). */
export interface ArLedgerInvoiceVoucher {
  id: string
  voucher_number: number
  voucher_series: string | null
  description: string | null
}

export interface ArLedgerInvoice {
  id: string
  customer_id: string | null
  customer_name: string | null
  invoice_number: string | null
  external_invoice_number: string | null
  invoice_date: string
  due_date: string
  status: string
  total: number | null
  paid_amount: number | null
  currency: string | null
  exchange_rate: number | null
  deduction_total: number | null
  deduction_reclaimed_total: number | null
  paid_at: string | null
  journal_entry_id: string | null
  /**
   * A SEK row: what its posted verifikat carries on 151x, 1513 aside, null
   * otherwise (issue-rounding-carried.ts reads the öresavrundning off it).
   */
  registered_receivable_sek?: number | null
  /** As of a date: the invoice has payment rows at all, of any date (InvoicePaymentFacts). */
  has_payment_rows: boolean
  /** As of a date: the amounts of its payment rows dated on or before it, in id order. */
  payment_amounts: number[] | null
  /** A credit note with a verifikat: the payment rows naming that verifikat. */
  credit_links: CreditNoteLink[] | null
  /** A ROT/RUT invoice: the items of its begäran that have a settlement verifikat. */
  payout_items: PayoutItemFact[] | null
  /** Only with `customerId`: the registration verifikat, or null. */
  voucher?: ArLedgerInvoiceVoucher | null
}

export interface ArLedgerInvoicesOptions {
  /** Reconstruct the population as of this date; omitted, the live state. */
  asOfDate?: string
  /** One customer's invoices, with their registration verifikat. */
  customerId?: string
}

/**
 * The ledger population, live or as of a date. Throws on a failed read (with
 * the SQLSTATE kept, see lib/errors/db-error.ts); each caller decides what a
 * failed read means for its report.
 */
export async function fetchArLedgerInvoices(
  supabase: SupabaseClient,
  companyId: string,
  options: ArLedgerInvoicesOptions = {},
): Promise<ArLedgerInvoice[]> {
  const { data, error } = await supabase.rpc('get_ar_ledger_invoices', {
    p_company_id: companyId,
    p_as_of_date: options.asOfDate ?? null,
    p_customer_id: options.customerId ?? null,
  })
  if (error) throw dbError(error, 'get_ar_ledger_invoices failed')
  return (Array.isArray(data) ? data : []) as ArLedgerInvoice[]
}
