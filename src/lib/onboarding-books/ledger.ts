/**
 * Ledger preview for the bank accounts the user ticks in onboarding. Mirrors
 * the server rule in lib/cash-accounts/service.ts (allocatePsd2LedgerAccount):
 * the currency default first, then the next free slot in 1931 to 1959. The
 * server allocates for real on PATCH /accounts; this only lets the sentence
 * say "Företagskonto bokförs på 1930" before the request goes.
 */

export const LEDGER_DEFAULT: Record<string, string> = {
  SEK: '1930',
  EUR: '1932',
  USD: '1933',
  GBP: '1934',
}

export const LEDGER_NAMES: Record<string, string> = {
  '1930': 'Företagskonto',
  '1932': 'Bankkonto EUR',
  '1933': 'Bankkonto USD',
  '1934': 'Bankkonto GBP',
  '1940': 'Övriga bankkonton',
}

export const LEDGER_MIN = 1931
export const LEDGER_MAX = 1959

export interface LedgerPickInput {
  uid: string
  currency: string
}

/** The 19xx slots a company can still hand out, in order. */
export function freeLedgerSlots(used: Iterable<string>): string[] {
  const taken = new Set(used)
  const out: string[] = []
  for (let n = LEDGER_MIN; n <= LEDGER_MAX; n++) {
    const s = String(n)
    if (!taken.has(s)) out.push(s)
  }
  return out
}

/**
 * Assign a 19xx account to every ticked bank account. A user pick wins when
 * that slot is free; otherwise the currency default, then the next free slot.
 * `used` are the company's existing cash-account ledgers (never reused).
 */
export function allocateLedgers(
  ticked: LedgerPickInput[],
  used: Iterable<string>,
  picks: Record<string, string | undefined> = {},
): Record<string, string> {
  const taken = new Set(used)
  const out: Record<string, string> = {}
  for (const a of ticked) {
    const pick = picks[a.uid]
    let ledger: string | null = pick && !taken.has(pick) ? pick : null
    if (!ledger) {
      const d = LEDGER_DEFAULT[a.currency.toUpperCase()]
      if (d && !taken.has(d)) ledger = d
    }
    if (!ledger) ledger = freeLedgerSlots(taken)[0] ?? '1940'
    taken.add(ledger)
    out[a.uid] = ledger
  }
  return out
}

/** The pick list for one account's Ändra row: its default first, then the free slots. */
export function ledgerOptions(currency: string, used: Iterable<string>, current: string): string[] {
  const taken = new Set(used)
  taken.delete(current)
  const d = LEDGER_DEFAULT[currency.toUpperCase()] ?? '1940'
  const list = [d, ...freeLedgerSlots(taken)].filter((v, i, arr) => arr.indexOf(v) === i && !taken.has(v))
  if (!list.includes(current)) list.unshift(current)
  return list.slice(0, 8)
}

export function ledgerName(ledger: string, currency: string, known: Record<string, string> = {}): string {
  return known[ledger] ?? LEDGER_NAMES[ledger] ?? `Bankkonto ${currency.toUpperCase()}`
}
