/**
 * Row shapes, tolerances and helpers shared by the customer-side
 * (voucher-matching.ts) and supplier-side (supplier-voucher-matching.ts)
 * "link an existing verifikat as the payment" flows. Both files read the same
 * journal tables and rank candidates the same way; only the account side
 * (151x credits vs 244x debits) and the invoice type differ.
 */

/** ±90 days from the invoice's due_date as the default search window. */
export const DEFAULT_DATE_WINDOW_DAYS = 90

/** Tolerance for floating-point comparisons on monetary amounts (0.5 öre). */
export const AMOUNT_TOLERANCE = 0.005

/** Date-proximity bump applied when entry_date is within ±7 days of due_date. */
export const DATE_PROXIMITY_BUMP = 0.05

export interface VoucherMatchLineRow {
  id: string
  journal_entry_id: string
  account_number: string
  debit_amount: number | null
  credit_amount: number | null
  /** Labels the DOCUMENT, NOT the unit of debit_amount/credit_amount. */
  currency: string | null
  /** The line's amount in `currency`: the only non-SEK figure on the row. */
  amount_in_currency: number | string | null
}

export interface VoucherRow {
  id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string
  status: string
  source_type: string | null
  fiscal_period_id: string
}

/** `fiscal_periods` has no `status` column: open/locked/closed is derived from
 *  `is_closed` + `locked_at`, exactly as the `enforce_period_lock` trigger
 *  (migration 017) and `resolvePeriodStatusForDate()` do it. */
export interface FiscalPeriodRow {
  id: string
  is_closed: boolean | null
  locked_at: string | null
}

/** SQL-side filter for posted, non-storno, non-opening entries. */
export const EXCLUDED_SOURCE_TYPES = ['opening_balance', 'storno']

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function isDateWithinDays(a: string, b: string, days: number): boolean {
  const ad = new Date(a).getTime()
  const bd = new Date(b).getTime()
  if (Number.isNaN(ad) || Number.isNaN(bd)) return false
  return Math.abs(ad - bd) <= days * 24 * 3600 * 1000
}
