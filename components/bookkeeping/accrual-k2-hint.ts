/**
 * K2 vasentlighetsgrans for periodisering, extracted as a pure helper so it
 * can be unit-tested (this repo's Vitest runs in a node environment and does
 * not render components).
 *
 * K2 (BFNAR 2016:10) lets a smaller company skip accruing individual
 * recurring costs below 5 000 kr that do not fluctuate more than 20 % year
 * over year; personnel costs must always be accrued. It is a simplification
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

/** BFNAR 2016:10: the K2 accrual simplification ceiling, in SEK. */
export const K2_ACCRUAL_THRESHOLD_SEK = 5000

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
 * Whether to show the "below 5 000 kr need not be deferred" hint.
 *
 * False whenever the SEK value is unknown: no hint beats a hint measured in
 * the wrong currency.
 */
export function shouldShowK2AccrualHint(input: AccrualAmountInput): boolean {
  const amountSek = resolveAccrualAmountSek(input)
  if (amountSek === null) return false
  return amountSek > 0 && amountSek < K2_ACCRUAL_THRESHOLD_SEK
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
  entityType?: 'enskild_firma' | 'aktiebolag' | null,
): 'k1_hint' | 'k2_hint' {
  return entityType === 'enskild_firma' ? 'k1_hint' : 'k2_hint'
}
