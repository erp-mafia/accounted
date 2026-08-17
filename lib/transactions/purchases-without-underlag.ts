/**
 * Purchases that have no underlag.
 *
 * The receipt hunt has asked this question since it was built, privately, in
 * `fetchCandidates`. The Underlag page needs the same answer to show a purchase
 * that is still missing its paper, so the query lives here now.
 *
 * The hunt is NOT yet migrated onto this: its query is byte-identical apart
 * from the booked check below, but rewiring a nightly cron belongs in its own
 * change with its own tests. The thresholds are deliberately kept equal to the
 * hunt's so the two cannot drift in the meantime, and the hunt's constants are
 * the source of that equality.
 *
 * One thing differs between the two callers, and it matters. The hunt filters on
 * `journal_entry_id IS NULL` alone, which is not the same as "not booked": a
 * bulk-booked transaction (many transactions, one verifikat, joined through
 * transaction_voucher_links) and a payment split across several invoices both
 * leave that column null. The hunt tolerates the false candidate, since the
 * worst case is a proposal nobody accepts. A list shown to a person does not:
 * those rows would sit under "saknar underlag" forever, already booked, with
 * nothing the user could do to clear them.
 *
 * So the column filter stays as the cheap first pass the database can index,
 * and `isTransactionBooked` settles it afterwards with the two link tables it
 * needs. That predicate is canonical; nothing here re-implements it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { isTransactionBooked } from '@/lib/transactions/is-booked'

/**
 * Deliberately below the receipt hunt's own floor (MIN_AMOUNT_SEK = 100 in
 * lib/receipt-hunt/hunt.ts), and the two are not meant to match.
 *
 * The hunt has a floor because every candidate costs a mail search and a model
 * read, so chasing a 45 kr purchase is not worth the spend. This list costs a
 * query. Bokföringslagen wants an underlag for the 45 kr purchase exactly as
 * much as for the 4 500 kr one, and the person can always upload it by hand
 * even when the hunt will not go looking.
 *
 * Matching the hunt's floor hid 52 of one real company's 119 unreceipted
 * purchases: the page under-reported by 44% and looked tidier for it.
 */
export const MIN_PURCHASE_AMOUNT_SEK = 0
export const PURCHASE_LOOKBACK_MONTHS = 12

export interface PurchaseWithoutUnderlag {
  id: string
  company_id: string
  date: string
  description: string | null
  merchant_name: string | null
  amount: number
  currency: string | null
  amount_sek: number | null
  exchange_rate: number | null
  journal_entry_id: string | null
}

const COLUMNS =
  'id, company_id, date, description, merchant_name, amount, currency, amount_sek, exchange_rate, journal_entry_id'

/**
 * Outflows with no document, not ignored, not privately flagged, and not booked
 * by any of the three routes a transaction can be booked through.
 *
 * Ordered newest first: a receipt for last week is findable, one from a year ago
 * usually is not.
 */
export async function fetchPurchasesWithoutUnderlag(
  supabase: SupabaseClient,
  companyId: string,
  options?: { lookbackMonths?: number; minAmountSek?: number },
): Promise<PurchaseWithoutUnderlag[]> {
  const lookback = options?.lookbackMonths ?? PURCHASE_LOOKBACK_MONTHS
  const minAmount = options?.minAmountSek ?? MIN_PURCHASE_AMOUNT_SEK

  const since = new Date()
  since.setMonth(since.getMonth() - lookback)
  const sinceDate = since.toISOString().slice(0, 10)

  const rows = await fetchAllRows<PurchaseWithoutUnderlag>((range) =>
    supabase
      .from('transactions')
      .select(COLUMNS)
      .eq('company_id', companyId)
      .is('journal_entry_id', null)
      .is('document_id', null)
      .eq('is_ignored', false)
      // is_business IS DISTINCT FROM false: NULL is untriaged and true is
      // "business, not yet booked". Only an explicit false means the user
      // called it private, and a private purchase needs no underlag.
      .not('is_business', 'is', false)
      // Outflows only. With no floor this is simply every negative row.
      .lt('amount', minAmount > 0 ? -minAmount : 0)
      .gte('date', sinceDate)
      .order('date', { ascending: false })
      .range(range.from, range.to),
  )

  if (rows.length === 0) return []

  // The column filter above cannot see these two. Fetched once for the whole
  // page rather than per row.
  const ids = rows.map((r) => r.id)
  const [{ data: voucherLinks }, { data: invoicePayments }, { data: supplierPayments }] =
    await Promise.all([
      supabase.from('transaction_voucher_links').select('transaction_id').in('transaction_id', ids),
      supabase.from('invoice_payments').select('transaction_id').in('transaction_id', ids),
      supabase.from('supplier_invoice_payments').select('transaction_id').in('transaction_id', ids),
    ])

  const payments = [...(invoicePayments ?? []), ...(supplierPayments ?? [])]
  return rows.filter((tx) => !isTransactionBooked(tx, payments, voucherLinks ?? []))
}
