/**
 * Currency handling for the plus-minus tolerance bands used by the
 * duplicate-payment / invoice-suggestion guards.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three guards built a plus-minus `DUPLICATE_AMOUNT_TOLERANCE_PCT` band around
 * one amount and then applied it, in SQL, to a column denominated in a
 * different currency:
 *
 *   - `findDuplicatePaymentCandidatesForInvoice`: band around the customer
 *     invoice's payment (invoice currency) applied to `transactions.amount`.
 *   - `POST /api/supplier-invoices/[id]/mark-paid`: band around the supplier
 *     invoice's payment (invoice currency) applied to `transactions.amount`.
 *   - `POST /api/transactions/[id]/categorize`: band around
 *     `transactions.amount` applied to `supplier_invoices.remaining_amount`
 *     and `invoices.remaining_amount`.
 *
 * At roughly 11,50 SEK/EUR a plus-minus 2 % band around a EUR figure is off by
 * a factor of eleven against a SEK column: it selects nothing, or it selects an
 * unrelated row that happens to sit at the wrong magnitude. Neither outcome is
 * a guard. The first silently lets a second verifikat be posted for one
 * affärshändelse (BFL 5 kap 1-2 §); the second points the user at the wrong
 * row.
 *
 * BASIS
 * -----
 * Same rule as `lib/invoices/supplier-invoice-matching.ts#comparableAmounts`
 * and `lib/documents/core-receipt-matcher.ts#amountVarianceForMatch`, so the
 * whole matching surface answers "are these the same money?" the same way:
 *
 *   1. Same currency on both sides -> compare raw magnitudes. Exact, needs no
 *      rate, and it is the ONLY path a SEK-only company ever takes.
 *   2. Different currencies -> compare in SEK, and only from STORED
 *      conversions (`amount_sek` / `total_sek` / `exchange_rate`).
 *   3. No stored conversion -> not comparable. The candidate is excluded, never
 *      compared as a raw number. Guessing the unit IS the bug.
 *
 * Because the band is applied in SQL, the query has to be split into one sweep
 * per currency: each sweep restricts the rows to a single currency and carries
 * the band expressed in that same currency. A SEK reference produces exactly
 * one sweep, so the query count and the band values are byte-identical to what
 * a SEK-only company saw before.
 */

import { roundOre } from '@/lib/money'

/**
 * Currency codes compare case-insensitively, and a missing code means SEK:
 * `transactions.currency` and `invoices.currency` are nullable with
 * DEFAULT 'SEK', so a legacy row carrying NULL is kronor and must keep
 * matching. `supplier_invoices.currency` is NOT NULL DEFAULT 'SEK'.
 */
export function normalizeCurrencyCode(code: string | null | undefined): string {
  return (code || 'SEK').toUpperCase()
}

/** ISO 4217 shape. Anything else cannot be embedded in a PostgREST filter. */
function isSafeCurrencyCode(code: string): boolean {
  return /^[A-Z]{3}$/.test(code)
}

/**
 * PostgREST `.or()` argument restricting a query to rows denominated in
 * `code`.
 *
 * Built as an `.or()` string rather than `.eq('currency', code)` because the
 * SEK case has to accept NULL as well. `code` is validated against the ISO
 * 4217 shape by `planAmountSweeps` before it reaches this function, so nothing
 * user-controlled is interpolated into PostgREST's filter DSL (the same
 * concern that keeps the merchant/customer name searches out of `.or()`).
 */
export function currencyRowFilter(code: string): string {
  return code === 'SEK' ? 'currency.is.null,currency.eq.SEK' : `currency.eq.${code}`
}

/** An amount expressed in its own currency, plus its SEK view when one exists. */
export interface ComparableAmount {
  /** Magnitude in `currency`. Sign is ignored throughout: bank expense rows are negative. */
  amount: number
  /** Normalised ISO code (`normalizeCurrencyCode`). */
  currency: string
  /** Magnitude in SEK from a STORED conversion, or null when none establishes one. */
  sek: number | null
}

/** One SQL prefilter: rows in `currencyFilter`, banded in that same currency. */
export interface AmountSweep {
  /** Argument for `.or()`: restricts the query to one currency. */
  currencyFilter: string
  /** ISO code the band below is expressed in. Diagnostics and tests. */
  currency: string
  /** Lower bound as a positive magnitude. */
  low: number
  /** Upper bound as a positive magnitude. */
  high: number
}

/** Plus-minus `pct` band around `value`, as positive magnitudes. */
export function toleranceBand(value: number, pct: number): { low: number; high: number } {
  const magnitude = Math.abs(value)
  return {
    low: roundOre(magnitude * (1 - pct)),
    high: roundOre(magnitude * (1 + pct)),
  }
}

/**
 * The SQL sweeps needed so the band and the column always share a unit.
 *
 *  - Always: the same-currency sweep (band in the reference's own currency,
 *    rows restricted to that currency). This is the whole plan for SEK.
 *  - Additionally, when the reference is foreign AND has a stored SEK value:
 *    a SEK sweep, so a EUR payment still finds the kronor bank row that
 *    actually paid it.
 *
 * A foreign reference with no stored SEK value gets only the same-currency
 * sweep and `crossCurrencyUnverifiable: true`. Callers surface that rather than
 * widening the band or comparing raw numbers.
 *
 * A reference currency that is not a clean ISO code yields NO sweeps: it cannot
 * be filtered on safely and it cannot be converted, so there is nothing
 * truthful to compare.
 */
export function planAmountSweeps(
  reference: ComparableAmount,
  pct: number,
): { sweeps: AmountSweep[]; crossCurrencyUnverifiable: boolean } {
  const sweeps: AmountSweep[] = []

  if (!isSafeCurrencyCode(reference.currency)) {
    return { sweeps, crossCurrencyUnverifiable: true }
  }

  const own = toleranceBand(reference.amount, pct)
  sweeps.push({
    currencyFilter: currencyRowFilter(reference.currency),
    currency: reference.currency,
    low: own.low,
    high: own.high,
  })

  if (reference.currency === 'SEK') {
    // Foreign rows are deliberately NOT swept for a SEK reference: their
    // `amount` column is not kronor, and banding their SEK column would need a
    // second predicate on a different column. Excluding them is the honest
    // outcome; comparing a SEK band against a foreign magnitude is what this
    // module exists to stop.
    return { sweeps, crossCurrencyUnverifiable: false }
  }

  if (reference.sek === null) {
    return { sweeps, crossCurrencyUnverifiable: true }
  }

  const sek = toleranceBand(reference.sek, pct)
  sweeps.push({
    currencyFilter: currencyRowFilter('SEK'),
    currency: 'SEK',
    low: sek.low,
    high: sek.high,
  })
  return { sweeps, crossCurrencyUnverifiable: false }
}

/**
 * Post-filter: do `reference` and `row` agree within `pct` in a unit they
 * actually share?
 *
 * Runs on the rows the sweeps returned, so a row that slipped through (a sweep
 * is a prefilter, and PostgREST `.or()` composes with the other filters rather
 * than replacing them) is still judged in a shared unit. False when no shared
 * unit exists: that is an exclusion, not a match.
 */
export function magnitudesWithinTolerance(
  reference: ComparableAmount,
  row: ComparableAmount,
  pct: number,
): boolean {
  if (reference.currency === row.currency) {
    return withinBand(row.amount, reference.amount, pct)
  }
  if (reference.sek === null || row.sek === null) return false
  return withinBand(row.sek, reference.sek, pct)
}

function withinBand(value: number, reference: number, pct: number): boolean {
  const { low, high } = toleranceBand(reference, pct)
  const magnitude = Math.abs(value)
  return magnitude >= low && magnitude <= high
}

/**
 * SEK magnitude of an invoice amount (`total`, or the still-unpaid
 * `remaining_amount`), or null when no stored conversion establishes one.
 *
 * `total_sek` covers the WHOLE invoice at the rate booked on registration while
 * `remaining_amount` is in the invoice currency, so a partially paid invoice
 * needs the same proportion of the SEK total. Same pro-rating as
 * `lib/invoices/supplier-invoice-matching.ts#remainingTotalSek`.
 *
 * `invoices.total_sek` DEFAULTs to 0 rather than NULL, so a zero is treated as
 * "not stored" instead of pro-rating every foreign invoice down to nothing.
 */
export function invoiceAmountSek(args: {
  /** Amount in the invoice currency (total, or remaining). */
  amount: number
  /** Normalised invoice currency. */
  currency: string
  /** `invoices.total` / `supplier_invoices.total`, in the invoice currency. */
  total?: number | null
  /** `invoices.total_sek` / `supplier_invoices.total_sek`. */
  totalSek?: number | null
  /** `invoices.exchange_rate` / `supplier_invoices.exchange_rate`: SEK per unit. */
  exchangeRate?: number | null
}): number | null {
  const amount = Number(args.amount)
  if (!Number.isFinite(amount)) return null
  if (args.currency === 'SEK') return roundOre(Math.abs(amount))

  const total = args.total == null ? null : Number(args.total)
  const totalSek = args.totalSek == null ? null : Number(args.totalSek)
  if (
    total !== null && Number.isFinite(total) && total !== 0 &&
    totalSek !== null && Number.isFinite(totalSek) && totalSek !== 0
  ) {
    return roundOre(Math.abs((amount / total) * totalSek))
  }

  const rate = args.exchangeRate == null ? null : Number(args.exchangeRate)
  if (rate !== null && Number.isFinite(rate) && rate > 0) {
    return roundOre(Math.abs(amount) * rate)
  }

  return null
}
