/**
 * The currency an Enable Banking account is stored and routed under.
 *
 * Enable Banking passes the bank's account currency through, and several
 * banks report 'XXX' there: ISO 4217 "no currency", the Berlin Group code for
 * an account without one fixed currency (Northmill, PayPal, Svea, SEB and
 * Nordea First Card in production). Stored verbatim it made the account
 * unbookable: each transaction arrives with its own currency (SEK), and the
 * bank-booking guards look the cash account up by the transaction's currency,
 * so an 'XXX' account never matched (feedback seq 753539).
 *
 * A reported currency that is not a usable ISO code ('XXX', empty, missing)
 * is resolved from what is already known about the same physical account,
 * strongest first: the currency we already store for it, then its balances'
 * balance_amount.currency, then its transactions' currency. Without any, SEK:
 * every such account seen in production carried only SEK transactions.
 * Never returns 'XXX'.
 */

const NO_CURRENCY = 'XXX'
const FALLBACK_CURRENCY = 'SEK'

function usableCurrency(value: string | null | undefined): string | null {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return /^[A-Z]{3}$/.test(code) && code !== NO_CURRENCY ? code : null
}

export function resolveAccountCurrency(
  reported: string | null | undefined,
  evidence: ReadonlyArray<string | null | undefined> = [],
): string {
  for (const candidate of [reported, ...evidence]) {
    const code = usableCurrency(candidate)
    if (code) return code
  }
  return FALLBACK_CURRENCY
}
