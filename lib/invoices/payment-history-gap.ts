import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { PAYMENT_VOUCHER_SOURCE_TYPES } from '@/lib/invoices/backfill-invoice-payment-rows'

const log = createLogger('invoices/payment-history-gap')

/**
 * What the Betalningar row on a customer invoice should say when the invoice
 * header reads paid but the AR sub-ledger (`invoice_payments`) has no row.
 *
 * The header state (`status`, `paid_amount`, `paid_at`) and the payment rows
 * have different writers. Every settlement path inside Accounted writes the
 * row fail-closed (lib/invoices/invoice-payment-row.ts), so a settled invoice
 * with no row was settled somewhere this ledger never saw:
 *
 *  - a provider migration imports the invoice already paid (extensions/
 *    general/arcim-migration mapSalesInvoice writes status, paid_amount and
 *    paid_at from the source system and nothing else). No payment voucher
 *    exists here either; the payment lives in the previous system's books.
 *  - a "Markera som betald" from before the sub-ledger existed (#2019) left
 *    a posted invoice_paid / invoice_cash_payment voucher with no row. The
 *    backfill repaired the single-voucher cases; what remains still has the
 *    voucher to show.
 *
 * Rendering "Inga registrerade betalningar ännu" under a paid header reads as
 * "still unpaid" and contradicts the header (#2213). The classifier below
 * turns the data state into the one honest line the row can carry instead.
 * No provenance column is needed: the state itself is the marker.
 */

export interface PaymentVoucherRef {
  id: string
  entry_date: string
  voucher_series: string | null
  voucher_number: number | null
}

export type PaymentHistoryGap =
  /** Rows exist (the list is the truth) or the invoice is not settled. */
  | { kind: 'none' }
  /** A lookup failed: say so rather than assert either provenance. */
  | { kind: 'unreadable' }
  /** Settled in Accounted, row missing: show the vouchers that settled it. */
  | { kind: 'vouchers_without_rows'; vouchers: PaymentVoucherRef[] }
  /** Settled before the invoice existed here: paid in the previous system. */
  | { kind: 'settled_before_accounted'; paid_at: string | null; full: boolean }

const SETTLED_STATUSES = new Set(['paid', 'partially_paid'])

export function classifyPaymentHistoryGap(input: {
  status: string
  paid_at?: string | null
  /** invoice_payments rows for the invoice; null when the lookup failed. */
  paymentRows: number | null
  /** Posted payment vouchers keyed on the invoice; null when the lookup failed. */
  paymentVouchers: PaymentVoucherRef[] | null
}): PaymentHistoryGap {
  if (!SETTLED_STATUSES.has(input.status)) return { kind: 'none' }
  if (input.paymentRows === null) return { kind: 'unreadable' }
  if (input.paymentRows > 0) return { kind: 'none' }
  if (input.paymentVouchers === null) return { kind: 'unreadable' }
  if (input.paymentVouchers.length > 0) {
    return { kind: 'vouchers_without_rows', vouchers: input.paymentVouchers }
  }
  return {
    kind: 'settled_before_accounted',
    paid_at: input.paid_at ?? null,
    full: input.status === 'paid',
  }
}

/**
 * Posted payment vouchers the invoice engine keyed on this invoice
 * (`source_id` = invoice id, `source_type` invoice_paid / invoice_cash_payment;
 * the (source_type, source_id) index makes this a point lookup). Returns null
 * when the query failed: unknown must never read as "no voucher".
 */
export async function fetchInvoicePaymentVouchers(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<PaymentVoucherRef[] | null> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('id, entry_date, voucher_series, voucher_number')
    .eq('source_id', invoiceId)
    .in('source_type', [...PAYMENT_VOUCHER_SOURCE_TYPES])
    .eq('status', 'posted')
    .order('entry_date', { ascending: true })
  if (error) {
    // The row then reads "kunde inte hämtas" instead of a provenance; the
    // failure itself must not stay invisible (ids and codes only, no PII).
    log.warn('payment voucher lookup failed', {
      invoiceId,
      code: error.code,
      message: error.message,
    })
    return null
  }
  return (data ?? []) as PaymentVoucherRef[]
}
