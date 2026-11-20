import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Source types of the vouchers that settle a customer invoice: what
 * settleInvoicePayment books (lib/bookkeeping/invoice-entries.ts) for a
 * "Markera som betald" or a Stripe settlement. The database check below
 * (check_invoice_payment_row_invariant) lists the same two; change both
 * together.
 */
export const PAYMENT_VOUCHER_SOURCE_TYPES = ['invoice_paid', 'invoice_cash_payment'] as const

/** What check_invoice_payment_row_invariant returns. */
export interface InvoicePaymentRowInvariant {
  /** Paid customer invoices with a posted payment voucher and no invoice_payments row. */
  missing_payment_rows: number
  companies: number
  /** At most 20 invoice ids, for the operator; no customer data. */
  sample_invoice_ids: string[]
}

/**
 * The AR sub-ledger rule from #2019: every settlement writes its
 * invoice_payments row through recordInvoicePaymentRow, because the
 * kontantmetod bokslut cut-off reads that table only and books a paid invoice
 * without a row as a fordran with vilande moms, counting revenue and VAT
 * twice. The rule lives in application code, so a writer that bypasses it
 * (the sandbox seeder did) breaks it silently; this check makes that visible.
 * Sandbox companies are left out: their books are demo data.
 *
 * Counted in SQL (a capped PostgREST read would undercount silently).
 */
export async function checkInvoicePaymentRowInvariant(
  supabase: SupabaseClient,
): Promise<InvoicePaymentRowInvariant> {
  const { data, error } = await supabase.rpc('check_invoice_payment_row_invariant')
  if (error) throw error
  const row = (data ?? {}) as Partial<InvoicePaymentRowInvariant>
  return {
    missing_payment_rows: Number(row.missing_payment_rows ?? 0),
    companies: Number(row.companies ?? 0),
    sample_invoice_ids: Array.isArray(row.sample_invoice_ids) ? row.sample_invoice_ids.map(String) : [],
  }
}
