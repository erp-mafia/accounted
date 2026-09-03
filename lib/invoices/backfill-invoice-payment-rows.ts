/**
 * Planner for the #2019 backfill: paid or partially paid customer invoices
 * that were settled through "Markera som betald" (or the Stripe sync) before
 * settleInvoicePayment wrote the AR sub-ledger row. Pure: the script in
 * scripts/backfill-invoice-payment-rows.ts owns the reads and writes.
 *
 * Deterministic on purpose (project doctrine: never guess). A row is planned
 * only when the invoice has exactly ONE posted payment voucher, so the
 * journal link is unambiguous. Everything else is reported and skipped:
 * zero vouchers (imported / migrated invoices never booked here), several
 * vouchers (partials whose split cannot be reconstructed from the header),
 * or a row already present (bank-matched, link-to-voucher, or an earlier run).
 */

/** Tag written to invoice_payments.notes so one DELETE reverts a whole run. */
export const BACKFILL_NOTES_TAG = 'backfill:#2019'

/** Source types settleInvoicePayment produces (lib/bookkeeping/invoice-entries.ts). */
export const PAYMENT_VOUCHER_SOURCE_TYPES = ['invoice_paid', 'invoice_cash_payment'] as const

export interface BackfillInvoice {
  id: string
  company_id: string
  user_id: string
  invoice_number: string | null
  status: string
  document_type: string | null
  currency: string | null
  exchange_rate: number | null
  paid_amount: number | null
  paid_at: string | null
}

export interface BackfillVoucher {
  id: string
  source_id: string | null
  source_type: string
  status: string
  entry_date: string
}

export interface BackfillPaymentRow {
  user_id: string
  company_id: string
  invoice_id: string
  payment_date: string
  amount: number
  currency: string
  exchange_rate: number | null
  journal_entry_id: string
  transaction_id: null
  notes: string
}

export type BackfillSkipReason =
  | 'has_rows'
  | 'not_invoice'
  | 'not_paid'
  | 'no_paid_amount'
  | 'no_payment_voucher'
  | 'multiple_payment_vouchers'

export type BackfillPlan =
  | { kind: 'insert'; row: BackfillPaymentRow }
  | { kind: 'skip'; reason: BackfillSkipReason; voucherIds?: string[] }

/**
 * Decide what to do for one invoice given every voucher whose source_id
 * points at it and how many invoice_payments rows it already has.
 */
export function planInvoicePaymentBackfill(
  invoice: BackfillInvoice,
  vouchers: BackfillVoucher[],
  existingRowCount: number,
): BackfillPlan {
  if (existingRowCount > 0) return { kind: 'skip', reason: 'has_rows' }
  if (invoice.document_type && invoice.document_type !== 'invoice') {
    return { kind: 'skip', reason: 'not_invoice' }
  }
  if (invoice.status !== 'paid' && invoice.status !== 'partially_paid') {
    return { kind: 'skip', reason: 'not_paid' }
  }
  const paidAmount = Number(invoice.paid_amount ?? 0)
  if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
    return { kind: 'skip', reason: 'no_paid_amount' }
  }

  const paymentVouchers = vouchers.filter(
    (v) =>
      v.source_id === invoice.id &&
      v.status === 'posted' &&
      (PAYMENT_VOUCHER_SOURCE_TYPES as readonly string[]).includes(v.source_type),
  )
  if (paymentVouchers.length === 0) return { kind: 'skip', reason: 'no_payment_voucher' }
  if (paymentVouchers.length > 1) {
    return {
      kind: 'skip',
      reason: 'multiple_payment_vouchers',
      voucherIds: paymentVouchers.map((v) => v.id),
    }
  }
  const voucher = paymentVouchers[0]

  // paid_at is set from the payment date in the settle path (UTC noon), so
  // its calendar date IS the payment date; a partial has no paid_at and
  // falls back to the voucher date, which the same path stamps from the
  // same input.
  const paymentDate = invoice.paid_at ? invoice.paid_at.slice(0, 10) : voucher.entry_date

  return {
    kind: 'insert',
    row: {
      user_id: invoice.user_id,
      company_id: invoice.company_id,
      invoice_id: invoice.id,
      payment_date: paymentDate,
      amount: Math.round(paidAmount * 100) / 100,
      currency: invoice.currency ?? 'SEK',
      exchange_rate: invoice.exchange_rate ?? null,
      journal_entry_id: voucher.id,
      transaction_id: null,
      notes: `${BACKFILL_NOTES_TAG} Markera som betald utan betalningsrad; verifikat ${voucher.id}`,
    },
  }
}
