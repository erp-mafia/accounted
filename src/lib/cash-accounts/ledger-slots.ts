/**
 * Which 19xx account a bank account books on, and what a new chart row for it
 * is called. One rule for the server allocation (findFreeLedgerAccount and the
 * chart writers in lib/cash-accounts) and the onboarding preview
 * (lib/onboarding-books/ledger.ts), which sends its choice as an explicit
 * mapping. Pure, so the client bundle can import it: a separate client copy
 * drifted once and put SEK accounts on 1932 named "Bankkonto EUR".
 */

/** Suggested BAS account per currency. */
export const CURRENCY_LEDGER_DEFAULTS: Record<string, string> = {
  SEK: '1930',
  EUR: '1932',
  USD: '1933',
  GBP: '1934',
}

export function defaultLedgerForCurrency(currency: string): string {
  return CURRENCY_LEDGER_DEFAULTS[currency.toUpperCase()] ?? '1930'
}

const RESERVED = new Set(Object.values(CURRENCY_LEDGER_DEFAULTS))

/**
 * The overflow slots in the order they are handed out: the free-use 1931 to
 * 1959 sub-accounts, never a currency default (each is reserved for its own
 * currency) and never one in `taken`. Numbers the chart does not have yet come
 * first: a chart imported from SIE names real bank accounts ("1931 Nordnet")
 * with no cash account behind them. The chart-occupied ones follow, so a full
 * 19xx chart still gets an answer.
 */
export function overflowLedgerSlots(taken: Iterable<string>, chart: Iterable<string> = []): string[] {
  const skip = new Set(taken)
  const named = new Set(chart)
  const fresh: string[] = []
  const occupied: string[] = []
  for (let n = 1931; n <= 1959; n++) {
    const slot = String(n)
    if (RESERVED.has(slot) || skip.has(slot)) continue
    if (named.has(slot)) occupied.push(slot)
    else fresh.push(slot)
  }
  return [...fresh, ...occupied]
}

/**
 * Chart name for a bank account's new free-use 19xx account: its currency,
 * never the number's. A standard BAS account keeps its BAS name instead.
 */
export function bankLedgerName(currency: string): string {
  return `Bankkonto ${currency.toUpperCase()}`
}
