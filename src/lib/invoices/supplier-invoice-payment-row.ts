import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { removeInvoicePaymentRow } from '@/lib/invoices/invoice-payment-row'
import { linkBasisColumnsFor, type LinkBasisInput } from '@/lib/links/stamp'

/**
 * The single writer of supplier_invoice_payments rows from TypeScript (the AP
 * sub-ledger), the twin of recordInvoicePaymentRow. Every settlement path
 * records its payment here: "Markera som betald" (settleSupplierPayment:
 * dashboard and v1), the bank match (bookSupplierBankMatch), an invoice
 * registered as paid privately and the reskontra import. `npm run check:guards`
 * (direct-invoice-payment-insert) refuses another insert under app/, lib/ or
 * extensions/, so the row's field semantics cannot drift per code path. The
 * SQL doors (match_batch_allocate, link_supplier_invoice_to_voucher,
 * attach_supplier_invoice_settlement_voucher, book_counterparty_setoff) write
 * the same columns.
 *
 * `amount` is the debt this payment settled (new paid_amount minus the prior
 * one), in INVOICE currency, never the cash that left the bank: payment-sync
 * reverses paid_amount by it, and an öre residual on 3740 is part of the debt
 * while a bank fee on 6570 is not.
 */
export interface RecordSupplierInvoicePaymentRowParams {
  userId: string
  companyId: string
  invoice: { id: string; currency?: string | null; paid_amount?: number | null }
  /** Booking date (YYYY-MM-DD); same value the voucher carries. */
  paymentDate: string
  /** paid_amount after this payment, in invoice currency. */
  newPaidAmount: number
  /** Null only for a payment the old system booked (the reskontra import). */
  journalEntryId: string | null
  /** The bank transaction that drove the payment. Default null. */
  transactionId?: string | null
  /** SEK booked on 3960/7960 for this payment. Default 0. */
  exchangeRateDifference?: number | null
  notes?: string | null
  /**
   * Why this payment is linked to the invoice (src/lib/links/link-basis.ts).
   * Required, so a new settlement path cannot write a link without saying why.
   */
  linkBasis: LinkBasisInput
}

export type RecordSupplierInvoicePaymentRowResult =
  | { ok: true; id: string }
  /** `code` is the Postgres SQLSTATE when the driver reported one ('23505' = unique violation). */
  | { ok: false; error: string; code?: string }

export async function recordSupplierInvoicePaymentRow(
  supabase: SupabaseClient,
  params: RecordSupplierInvoicePaymentRowParams,
): Promise<RecordSupplierInvoicePaymentRowResult> {
  const { userId, companyId, invoice, paymentDate, newPaidAmount, journalEntryId, transactionId, exchangeRateDifference, notes, linkBasis } = params

  const { data, error } = await supabase
    .from('supplier_invoice_payments')
    .insert({
      user_id: userId,
      company_id: companyId,
      supplier_invoice_id: invoice.id,
      payment_date: paymentDate,
      amount: roundOre(newPaidAmount - (invoice.paid_amount ?? 0)),
      currency: invoice.currency ?? 'SEK',
      exchange_rate_difference: exchangeRateDifference ?? 0,
      journal_entry_id: journalEntryId,
      transaction_id: transactionId ?? null,
      notes: notes ?? null,
      ...linkBasisColumnsFor(linkBasis),
    })
    .select('id')
    .single()

  if (error || !data) {
    return {
      ok: false,
      error: error?.message ?? 'no_row_returned',
      ...(error?.code ? { code: error.code } : {}),
    }
  }
  return { ok: true, id: (data as { id: string }).id }
}

/** Undo the row on a failed settlement: see removeInvoicePaymentRow. Never throws. */
export function removeSupplierInvoicePaymentRow(
  supabase: SupabaseClient,
  companyId: string,
  paymentRowId: string | null,
): Promise<boolean> {
  return removeInvoicePaymentRow(supabase, companyId, paymentRowId, 'supplier_invoice_payments')
}
