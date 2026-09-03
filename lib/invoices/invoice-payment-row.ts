import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'

const log = createLogger('invoice-payment-row')

/**
 * The AR sub-ledger row for a payment that no bank transaction drives:
 * "Markera som betald" (dashboard, v1, MCP) and the Stripe payment sync.
 *
 * Without the row the payment has no DATE anywhere. The kontantmetod bokslut
 * cut-off (lib/core/bookkeeping/kontantmetod-cutoff.ts) reads invoice_payments
 * only and would book a paid invoice as a fordran with vilande moms at year
 * end, double-counting revenue and VAT (#2019); the Betalningar view and the
 * voucher -> invoice reference map read the same table.
 *
 * Shape mirrors the bank-match path (app/api/transactions/[id]/match-invoice):
 * amount in INVOICE currency, transaction_id null. The
 * (transaction_id, invoice_id) unique index treats nulls as distinct, so
 * several manual partials on one invoice coexist; (journal_entry_id,
 * invoice_id) still refuses the same voucher twice.
 *
 * `amount` is the amount APPLIED to the invoice (new paid_amount minus the
 * prior one), not the cash received: a SEK öresavrundning overshoot absorbed
 * on 3740 is part of the voucher but not of the receivable, and every reader
 * subtracts rows from `total`.
 */
export interface RecordInvoicePaymentRowParams {
  userId: string
  companyId: string
  invoice: {
    id: string
    currency?: string | null
    exchange_rate?: number | null
    paid_amount?: number | null
  }
  /** Booking date (YYYY-MM-DD); same value the voucher carries. */
  paymentDate: string
  /** paid_amount after this payment, in invoice currency. */
  newPaidAmount: number
  journalEntryId: string | null
}

export type RecordInvoicePaymentRowResult =
  | { ok: true; id: string }
  | { ok: false; error: string }

export async function recordInvoicePaymentRow(
  supabase: SupabaseClient,
  params: RecordInvoicePaymentRowParams,
): Promise<RecordInvoicePaymentRowResult> {
  const { userId, companyId, invoice, paymentDate, newPaidAmount, journalEntryId } = params
  const amount = roundOre(newPaidAmount - (invoice.paid_amount ?? 0))

  const { data, error } = await supabase
    .from('invoice_payments')
    .insert({
      user_id: userId,
      company_id: companyId,
      invoice_id: invoice.id,
      payment_date: paymentDate,
      amount,
      currency: invoice.currency ?? 'SEK',
      exchange_rate: invoice.exchange_rate ?? null,
      journal_entry_id: journalEntryId,
      transaction_id: null,
      notes: null,
    })
    .select('id')
    .single()

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'no_row_returned' }
  }
  return { ok: true, id: (data as { id: string }).id }
}

/**
 * Undo the row on a failed settlement. Best-effort like the voucher storno
 * next to it: the caller is already on a decided error path (race or update
 * failure), and that response must not be replaced by a delete error. Never
 * throws, but never silent either: a row that survives here points at a
 * cancelled voucher for an invoice that never reached paid, and the
 * kontantmetod cut-off would read it as a settlement, so the failure is
 * logged at error level with everything an operator needs to delete it.
 *
 * @returns true when the row is gone, false when it may be stranded.
 */
export async function removeInvoicePaymentRow(
  supabase: SupabaseClient,
  companyId: string,
  paymentRowId: string | null,
): Promise<boolean> {
  if (!paymentRowId) return true
  const ctx = { companyId, invoicePaymentId: paymentRowId }
  try {
    const { error } = await supabase
      .from('invoice_payments')
      .delete()
      .eq('id', paymentRowId)
      .eq('company_id', companyId)
    if (error) {
      log.error('invoice_payments rollback failed (row may be stranded)', error, ctx)
      return false
    }
    return true
  } catch (err) {
    log.error('invoice_payments rollback threw (row may be stranded)', err as Error, ctx)
    return false
  }
}
