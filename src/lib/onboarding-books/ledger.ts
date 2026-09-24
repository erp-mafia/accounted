/**
 * Ledger preview for the bank accounts the user ticks in onboarding. Mirrors
 * the server rule in lib/cash-accounts/service.ts (findFreeLedgerAccount):
 * the currency default first, then the next free slot in 1931 to 1959. The
 * currency default is only blocked by a row another bank connection syncs
 * onto; a manual row on it (the 1930 every company is seeded with, the bank
 * account an SIE import brought) is promoted in place by the server, so the
 * first bank account lands on the ledger the books already use. Overflow
 * skips every existing row. The PATCH /accounts request sends this choice as
 * an explicit mapping, so the preview must not be stricter than the server.
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
 * `used` are the company's existing cash-account ledgers (never handed out as
 * overflow). `connected` are the ledgers held by another bank connection: only
 * those block the currency default, see the header. Omitted, every used
 * ledger blocks it.
 */
export function allocateLedgers(
  ticked: LedgerPickInput[],
  used: Iterable<string>,
  picks: Record<string, string | undefined> = {},
  connected?: Iterable<string>,
): Record<string, string> {
  const taken = new Set(used)
  const blocksDefault = connected === undefined ? new Set(taken) : new Set(connected)
  const out: Record<string, string> = {}
  for (const a of ticked) {
    const pick = picks[a.uid]
    const d = LEDGER_DEFAULT[a.currency.toUpperCase()]
    let ledger: string | null = pick && (!taken.has(pick) || (pick === d && !blocksDefault.has(pick))) ? pick : null
    if (!ledger && d && !blocksDefault.has(d)) ledger = d
    if (!ledger) ledger = freeLedgerSlots(taken)[0] ?? '1940'
    taken.add(ledger)
    blocksDefault.add(ledger)
    out[a.uid] = ledger
  }
  return out
}

/**
 * Split the company's cash accounts into what {@link allocateLedgers} needs,
 * seen from one bank connection: `used` is every ledger held by a row outside
 * that connection, `connected` only those another enabled bank connection
 * syncs onto.
 */
export function ledgerClaims(
  cashAccounts: ReadonlyArray<{ ledger_account: string; bank_connection_id: string | null; enabled?: boolean | null }>,
  connectionId: string | null,
): { used: string[]; connected: string[] } {
  const others = cashAccounts.filter((c) => c.bank_connection_id !== connectionId)
  return {
    used: others.map((c) => c.ledger_account),
    connected: others
      .filter((c) => c.bank_connection_id !== null && c.enabled !== false)
      .map((c) => c.ledger_account),
  }
}

/**
 * The pick list for one account's Ändra row: its default first, then the free
 * slots. `connected` works as in {@link allocateLedgers}: when given, only
 * those ledgers keep the currency default off the list.
 */
export function ledgerOptions(currency: string, used: Iterable<string>, current: string, connected?: Iterable<string>): string[] {
  const taken = new Set(used)
  taken.delete(current)
  const blocksDefault = connected === undefined ? taken : new Set(connected)
  const d = LEDGER_DEFAULT[currency.toUpperCase()] ?? '1940'
  const list = [d, ...freeLedgerSlots(taken)].filter(
    (v, i, arr) => arr.indexOf(v) === i && (v === d ? !blocksDefault.has(v) : !taken.has(v)),
  )
  if (!list.includes(current)) list.unshift(current)
  return list.slice(0, 8)
}

export function ledgerName(ledger: string, currency: string, known: Record<string, string> = {}): string {
  return known[ledger] ?? LEDGER_NAMES[ledger] ?? `Bankkonto ${currency.toUpperCase()}`
}
