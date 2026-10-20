/**
 * K2 vasentlighetsgrans for periodisering, extracted as a pure helper so it
 * can be unit-tested (this repo's Vitest runs in a node environment and does
 * not render components).
 *
 * K2 (BFNAR 2016:10) lets a smaller company skip accruing individual
 * recurring costs below 5 000 kr that do not fluctuate more than 20 % year
 * over year; personnel costs must always be accrued. BFNAR 2025:2 raises the
 * limit to 7 000 kr per post (2.4) for räkenskapsår beginning after
 * 2025-12-31; K1 (BFNAR 2006:1, förenklat årsbokslut) keeps its 5 000 kr. The
 * limit therefore follows the fiscal year the line is booked in
 * (accrualThresholdSek). It is a simplification
 * the company MAY use, never an obligation, so the UI copy it drives is
 * advisory only. That is exactly why it must not fire on an amount we cannot
 * express in kronor: an advisory nudge based on the wrong unit is worse than
 * no nudge at all.
 *
 * The invoice editors hold line amounts in the invoice's currency. A 500 EUR
 * line is roughly 5 750 kr and therefore ABOVE the threshold, but a naive
 * `amount < 5000` reads it as below (and a 400 USD line reads the reverse
 * way once the rate moves). Converting needs an FX rate. The supplier-invoice
 * form has one (Riksbanken-fetched or hand-typed); the customer-invoice
 * editor has none. When no rate is available we return null and the caller
 * shows nothing, rather than guessing a branch.
 */

import type { EntityType } from '@/types'
import { simplifiedYearEndRegelverk } from '@/lib/company/entity-type'

/** BFNAR 2016:10 before BFNAR 2025:2, and K1 (BFNAR 2006:1): the accrual simplification ceiling, in SEK. */
export const K2_ACCRUAL_THRESHOLD_SEK = 5000

/** K2 2.4 as amended by BFNAR 2025:2, for räkenskapsår beginning after 2025-12-31, in SEK. */
export const K2_ACCRUAL_THRESHOLD_2026_SEK = 7000

/** The first räkenskapsår start BFNAR 2025:2 applies to. */
const BFNAR_2025_2_FROM = '2026-01-01'

/**
 * The accrual simplification ceiling for a line booked in the fiscal year
 * starting `fiscalYearStart`: 7 000 kr under K2 from a year starting
 * 2026-01-01 or later, else 5 000 kr. An unknown year keeps 5 000 kr, the
 * lower of the two: advice under it holds under either.
 */
export function accrualThresholdSek(input: { entityType?: EntityType | null; fiscalYearStart?: string | null }): number {
  if (accrualHintKey(input.entityType) === 'k1_hint') return K2_ACCRUAL_THRESHOLD_SEK
  return input.fiscalYearStart && input.fiscalYearStart >= BFNAR_2025_2_FROM ? K2_ACCRUAL_THRESHOLD_2026_SEK : K2_ACCRUAL_THRESHOLD_SEK
}

export interface AccrualAmountInput {
  /** Net line amount, expressed in `currency`. */
  amount: number
  /** ISO currency code of `amount`. Missing/empty is treated as SEK. */
  currency?: string | null
  /** SEK per one unit of `currency`. Required to convert anything non-SEK. */
  exchangeRate?: number | null
}

/**
 * The line amount in SEK, or null when it cannot be determined.
 *
 * Deliberately NOT `resolveSekAmount()` from `@/lib/bookkeeping/currency-utils`:
 * that helper falls back to returning the foreign amount untouched, which is
 * the silent wrong-unit branch this helper exists to avoid.
 */
export function resolveAccrualAmountSek({
  amount,
  currency,
  exchangeRate,
}: AccrualAmountInput): number | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null

  const code = (currency ?? '').trim().toUpperCase()
  if (code === '' || code === 'SEK') {
    return Math.round(amount * 100) / 100
  }

  if (
    typeof exchangeRate !== 'number' ||
    !Number.isFinite(exchangeRate) ||
    exchangeRate <= 0
  ) {
    return null
  }

  return Math.round(amount * exchangeRate * 100) / 100
}

/**
 * Whether to show the "below 5 000 kr (7 000 kr) need not be deferred" hint.
 *
 * False whenever the SEK value is unknown: no hint beats a hint measured in
 * the wrong currency.
 */
export function shouldShowK2AccrualHint(input: AccrualAmountInput & { thresholdSek?: number }): boolean {
  const amountSek = resolveAccrualAmountSek(input)
  if (amountSek === null) return false
  return amountSek > 0 && amountSek < (input.thresholdSek ?? K2_ACCRUAL_THRESHOLD_SEK)
}

/**
 * Whether a line's periodisering is worth opening on its own (the reading's
 * service period): at or above the ceiling, or of a kronor value not yet
 * known (a foreign line before its rate), which a person then judges.
 */
export function accrualWorthOpening(input: AccrualAmountInput & { thresholdSek: number }): boolean {
  const amountSek = resolveAccrualAmountSek(input)
  return amountSek === null || amountSek >= input.thresholdSek
}

/**
 * Which `accruals.*` message key carries the materiality hint for the given
 * entity type. An enskild firma normally closes under K1 (BFNAR 2006:1,
 * förenklat årsbokslut), which relieves posts below 5 000 kr; citing K2
 * (BFNAR 2016:10) at a sole trader names a regelverk that does not apply to
 * it. There is no stored förenklat-vs-full-årsbokslut flag, so entity_type
 * is a proxy and the copy stays advisory ("behöver normalt inte").
 *
 * Unknown/missing entity keeps the K2 wording: it is the historical default
 * and correct for every aktiebolag.
 */
export function accrualHintKey(
  entityType?: EntityType | null,
): 'k1_hint' | 'k2_hint' {
  if (!entityType) return 'k2_hint'
  return simplifiedYearEndRegelverk(entityType) === 'K1' ? 'k1_hint' : 'k2_hint'
}
