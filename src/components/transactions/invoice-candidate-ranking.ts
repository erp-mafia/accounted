/**
 * Pure amount-proximity ranking for the manual invoice pickers
 * (InvoicePicker, SupplierInvoicePicker).
 *
 * Lives outside those components (both `'use client'`) so the rule below can be
 * unit tested: this repo runs Vitest in the `node` environment and never
 * renders components, so logic embedded in JSX is unverifiable by construction.
 *
 * # Why this exists
 *
 * Both pickers ranked candidates by `Math.abs(remaining - |tx.amount|)` with no
 * regard for currency, so a 1 000 EUR invoice sorted to the very top as a
 * perfect match for a 1 000 SEK bank row: same number, roughly eleven times the
 * money. The genuine 1 000 SEK invoice sat below it, and the pre-selected row
 * in a two-click flow was the wrong one.
 *
 * This is a RANKING fix, not a filter. The manual pickers deliberately list
 * every open invoice regardless of currency, because the user must still be
 * able to settle a foreign invoice by hand. Nothing is ever removed from the
 * list here; rows only move.
 *
 * # The three tiers
 *
 *   1. `same_currency`: both sides carry the same currency, so the difference
 *      is exact money. Ranked by that difference. Only this tier may claim a
 *      match.
 *   2. `converted_sek`: the currencies differ but both sides have a
 *      deterministic SEK value, so a real difference exists. Ranked by it,
 *      behind an equally close same-currency row.
 *   3. `incomparable`: no shared unit exists (a foreign invoice with no booked
 *      exchange rate, or a foreign bank row with no `amount_sek`). Still
 *      listed, never ranked on a meaningless number: these sink to the bottom
 *      in invoice-date order.
 *
 * Tiers 1 and 2 rank against each other by their difference rather than
 * strictly by tier. A SEK deposit of 11 500 kr settling a 1 000 EUR invoice is
 * the whole reason cross-currency matching exists; burying that invoice under
 * every wildly-off SEK invoice would trade one bad ranking for another.
 * `BankTransactionPicker` puts same-currency rows strictly first instead, and
 * that is right for it: its target is a half-typed invoice form whose amount
 * has no SEK equivalent yet, so tier 2 is unreachable there and the tie-break
 * never comes up. Here both sides are persisted rows that carry their own
 * conversion data.
 *
 * The SEK conversion mirrors `match_batch_allocate` (migration
 * 20260531120000_match_batch_allocate_cross_currency.sql), which values a
 * cross-currency settlement as `invoice.remaining * invoice.exchange_rate` and
 * refuses the match outright (BATCH_FX_RATE_MISSING) when that rate is missing.
 * Ranking on the same rule means the order the user sees agrees with what the
 * booking path will actually accept.
 */
import { isValidExchangeRate } from '@/lib/utils'

/**
 * `transactions.currency` and `invoices.currency` are both nullable
 * (`text default 'SEK'`, no NOT NULL); `supplier_invoices.currency` is NOT
 * NULL. A NULL or blank value has always meant a domestic row, so a plain
 * `a.currency === b.currency` would read NULL as "some other currency" and
 * demote a perfectly ordinary SEK invoice into the unranked tier. Normalize
 * before every comparison.
 */
export const DOMESTIC_CURRENCY = 'SEK'

export function normalizeCurrency(currency: string | null | undefined): string {
  const normalized = (currency ?? '').trim().toUpperCase()
  return normalized === '' ? DOMESTIC_CURRENCY : normalized
}

/** Money rounding per CLAUDE.md: never `toFixed()`. */
function roundOre(amount: number): number {
  return Math.round(amount * 100) / 100
}

export interface ProximityTarget {
  /** Bank transaction amount in `currency`. Sign is ignored. */
  amount: number
  /** `transactions.currency`. Nullable in the DB; normalized to SEK. */
  currency: string | null | undefined
  /**
   * `transactions.amount_sek`. Null on domestic rows and on rows that predate
   * the column, which is exactly why a foreign bank row can be incomparable.
   */
  amountSek?: number | null
}

export interface ProximityCandidate {
  /** Outstanding amount in `currency`. Sign is ignored. */
  amount: number
  currency: string | null | undefined
  /**
   * `invoices.exchange_rate` / `supplier_invoices.exchange_rate`: the rate the
   * receivable/payable was booked at, candidate currency -> SEK. Null on SEK
   * invoices by construction, and null on foreign invoices whose rate was
   * never established.
   */
  exchangeRate?: number | null
}

export type ProximityBasis = 'same_currency' | 'converted_sek' | 'incomparable'

export interface AmountProximity {
  basis: ProximityBasis
  /** `|target - candidate|` expressed in `diffCurrency`. Null when incomparable. */
  diff: number | null
  /** The currency `diff` is expressed in. Null when incomparable. */
  diffCurrency: string | null
  /**
   * The candidate amount converted to SEK. Null when no conversion happened
   * (the candidate is already SEK) or none is possible (no usable booked
   * rate). Set independently of whether the comparison itself succeeded, so
   * the row can show its SEK value even when the bank side is unconvertible.
   */
  candidateSek: number | null
  /**
   * Exact hit, to the öre. Stays false on a converted comparison on purpose:
   * that figure values the invoice at its own booking rate, not at what the
   * bank actually moved, so the two agreeing to the öre would be a
   * coincidence rather than a confirmation. Such a row still ranks by its
   * converted difference; it just never claims to be a match.
   */
  exact: boolean
  /** Near hit: within 1% of the target. Same-currency only, same reasoning. */
  close: boolean
}

/**
 * The candidate amount in SEK, or null when no conversion happened or none is
 * possible. Deliberately returns null (not the amount) for a SEK candidate:
 * callers use a non-null value to mean "a conversion was performed", which is
 * the only case worth showing next to the row.
 */
function convertToSek(
  amount: number,
  currency: string,
  exchangeRate: number | null | undefined,
): number | null {
  if (currency === DOMESTIC_CURRENCY) return null
  if (!isValidExchangeRate(exchangeRate)) return null
  return roundOre(amount * exchangeRate)
}

/**
 * How close a candidate invoice is to a bank transaction, and on what basis.
 * Never throws and never guesses: an unconvertible pair reports
 * `incomparable` rather than comparing two numbers in different units.
 */
export function compareAmountProximity(
  target: ProximityTarget,
  candidate: ProximityCandidate,
): AmountProximity {
  const targetAmount = Math.abs(target.amount)
  const targetCurrency = normalizeCurrency(target.currency)
  const candidateAmount = Math.abs(candidate.amount)
  const candidateCurrency = normalizeCurrency(candidate.currency)

  if (targetCurrency === candidateCurrency) {
    const diff = roundOre(Math.abs(candidateAmount - targetAmount))
    return {
      basis: 'same_currency',
      diff,
      diffCurrency: candidateCurrency,
      candidateSek: null,
      exact: diff < 0.01,
      close: diff >= 0.01 && targetAmount > 0 && diff / targetAmount < 0.01,
    }
  }

  const candidateSek = convertToSek(candidateAmount, candidateCurrency, candidate.exchangeRate)
  const candidateInSek = candidateCurrency === DOMESTIC_CURRENCY ? candidateAmount : candidateSek
  const targetInSek =
    targetCurrency === DOMESTIC_CURRENCY
      ? targetAmount
      : target.amountSek != null
        ? Math.abs(target.amountSek)
        : null

  if (candidateInSek == null || targetInSek == null) {
    return {
      basis: 'incomparable',
      diff: null,
      diffCurrency: null,
      candidateSek,
      exact: false,
      close: false,
    }
  }

  return {
    basis: 'converted_sek',
    diff: roundOre(Math.abs(candidateInSek - targetInSek)),
    diffCurrency: DOMESTIC_CURRENCY,
    candidateSek,
    exact: false,
    close: false,
  }
}

/** Structural shape shared by `Invoice` and `SupplierInvoice`. */
export interface RankableInvoice {
  remaining_amount?: number | null
  total: number
  currency?: string | null
  exchange_rate?: number | null
  invoice_date: string
}

export interface RankedInvoice<T> {
  invoice: T
  proximity: AmountProximity
}

const BASIS_RANK: Record<ProximityBasis, number> = {
  same_currency: 0,
  converted_sek: 1,
  incomparable: 2,
}

/**
 * Orders open invoices for a manual picker: closest comparable amount first,
 * unrankable rows last but never dropped. Ties fall back to an exact-unit
 * comparison over an FX estimate, then to newest invoice first, which is the
 * order the pickers used before amount proximity existed.
 */
export function rankInvoicesByAmountProximity<T extends RankableInvoice>(
  invoices: T[],
  target: ProximityTarget,
): RankedInvoice<T>[] {
  return invoices
    .map((invoice) => ({
      invoice,
      proximity: compareAmountProximity(target, {
        amount: invoice.remaining_amount ?? invoice.total,
        currency: invoice.currency,
        exchangeRate: invoice.exchange_rate,
      }),
    }))
    .sort((a, b) => {
      const diffA = a.proximity.diff
      const diffB = b.proximity.diff
      if ((diffA == null) !== (diffB == null)) return diffA == null ? 1 : -1
      if (diffA != null && diffB != null && diffA !== diffB) return diffA - diffB
      const basisDelta = BASIS_RANK[a.proximity.basis] - BASIS_RANK[b.proximity.basis]
      if (basisDelta !== 0) return basisDelta
      return b.invoice.invoice_date.localeCompare(a.invoice.invoice_date)
    })
}
