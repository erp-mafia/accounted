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

import { roundOre } from '@/lib/money'

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
  /**
   * What the voucher actually applied to the receivable, in SEK: the 1510
   * credit for a clearing entry (faktureringsmetoden), else the debit on the
   * settlement account (19xx / 1686) for a kontantmetoden cash entry. null
   * when neither leg exists; undefined when the caller did not load lines.
   */
  settlement_sek?: number | null
}

/**
 * Derive `settlement_sek` from a voucher's lines. Exported for the script and
 * its test; the planner only consumes the result.
 */
export function settlementSekFromLines(
  lines: Array<{ account_number: string; debit_amount: number | null; credit_amount: number | null }>,
): number | null {
  const credit1510 = lines
    .filter((l) => l.account_number === '1510')
    .reduce((sum, l) => sum + Number(l.credit_amount ?? 0), 0)
  if (credit1510 > 0) return roundOre(credit1510)
  const settlementDebit = lines
    .filter((l) => l.account_number.startsWith('19') || l.account_number === '1686')
    .reduce((sum, l) => sum + Number(l.debit_amount ?? 0), 0)
  if (settlementDebit > 0) return roundOre(settlementDebit)
  return null
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
  | 'rows_short'
  | 'not_invoice'
  | 'not_paid'
  | 'no_paid_amount'
  | 'no_payment_voucher'
  | 'multiple_payment_vouchers'
  | 'voucher_amount_mismatch'
  | 'voucher_amount_unverifiable'
  | 'period_closed'

export type BackfillPlan =
  | { kind: 'insert'; row: BackfillPaymentRow }
  | { kind: 'skip'; reason: BackfillSkipReason; voucherIds?: string[] }

export interface ExistingPaymentRows {
  count: number
  /** Sum of invoice_payments.amount, invoice currency. */
  sum: number
}

/**
 * Decide what to do for one invoice given every voucher whose source_id
 * points at it and the invoice_payments rows it already has.
 *
 * Rows present but summing to less than paid_amount means an earlier manual
 * partial has no row while a later bank-matched one does. That invoice is
 * `rows_short`: reported for a human, never patched, because the difference
 * cannot be attributed to a voucher without guessing.
 */
export interface BackfillPlanOptions {
  /**
   * Whether the fiscal period covering `date` (YYYY-MM-DD) for this invoice's
   * company is closed or locked. A row dated into such a period changes facts
   * a filed bokslut or deklaration relied on, so it is reported, not written.
   */
  isPeriodClosed?: (date: string) => boolean
}

export function planInvoicePaymentBackfill(
  invoice: BackfillInvoice,
  vouchers: BackfillVoucher[],
  existing: ExistingPaymentRows,
  options: BackfillPlanOptions = {},
): BackfillPlan {
  const paidAmountRaw = Number(invoice.paid_amount ?? 0)
  if (existing.count > 0) {
    const short = roundOre(paidAmountRaw - existing.sum)
    return short > 0 ? { kind: 'skip', reason: 'rows_short' } : { kind: 'skip', reason: 'has_rows' }
  }
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

  // The row must agree with what the voucher booked, or the cut-off inherits
  // a header figure the ledger never carried. SEK invoices must match to the
  // öre band; foreign-currency ones are checked through the invoice rate
  // within 1 %. An unreadable voucher (no 1510 credit, no settlement debit) or
  // a rate-less foreign invoice cannot be verified and is left to a human.
  const settlementSek = voucher.settlement_sek
  if (settlementSek === undefined || settlementSek === null) {
    return { kind: 'skip', reason: 'voucher_amount_unverifiable', voucherIds: [voucher.id] }
  }
  const currency = invoice.currency ?? 'SEK'
  if (currency === 'SEK') {
    if (Math.abs(settlementSek - paidAmount) > 0.5) {
      return { kind: 'skip', reason: 'voucher_amount_mismatch', voucherIds: [voucher.id] }
    }
  } else {
    const rate = Number(invoice.exchange_rate ?? 0)
    if (!(rate > 0)) {
      return { kind: 'skip', reason: 'voucher_amount_unverifiable', voucherIds: [voucher.id] }
    }
    if (Math.abs(settlementSek / rate - paidAmount) > paidAmount * 0.01) {
      return { kind: 'skip', reason: 'voucher_amount_mismatch', voucherIds: [voucher.id] }
    }
  }

  // The voucher's entry_date is the affärshändelse date (BFL 5 kap 7 §) and
  // is what the settle paths stamp from the user's payment date. paid_at is
  // NOT usable: before 2026-08-02 (#1332) it was the wall-clock registration
  // time, so a payment booked in January for a December date would land in
  // the wrong year. The two agree for every row written since.
  const paymentDate = voucher.entry_date

  if (options.isPeriodClosed?.(paymentDate)) {
    return { kind: 'skip', reason: 'period_closed', voucherIds: [voucher.id] }
  }

  return {
    kind: 'insert',
    row: {
      user_id: invoice.user_id,
      company_id: invoice.company_id,
      invoice_id: invoice.id,
      payment_date: paymentDate,
      amount: roundOre(paidAmount),
      currency: invoice.currency ?? 'SEK',
      exchange_rate: invoice.exchange_rate ?? null,
      journal_entry_id: voucher.id,
      transaction_id: null,
      notes: `${BACKFILL_NOTES_TAG} Markera som betald utan betalningsrad; verifikat ${voucher.id}`,
    },
  }
}
