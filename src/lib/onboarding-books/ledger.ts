/**
 * Ledger preview for the bank accounts the user ticks in onboarding, on the
 * server's own slot rule (lib/cash-accounts/ledger-slots.ts, which
 * findFreeLedgerAccount uses too): the currency default first, then the next
 * overflow slot. The currency default is only blocked by a row another bank
 * connection syncs onto; a manual row on it (the 1930 every company is seeded
 * with, the bank account an SIE import brought) is promoted in place by the
 * server, so the first bank account lands on the ledger the books already use.
 * Overflow skips every existing row. The PATCH /accounts request sends this
 * choice as an explicit mapping, so the preview must not be stricter than the
 * server.
 */

import { CURRENCY_LEDGER_DEFAULTS, bankLedgerName, overflowLedgerSlots } from '@/lib/cash-accounts/ledger-slots'

/** Names for the standard BAS bank accounts when the chart has none. */
export const LEDGER_NAMES: Record<string, string> = {
  '1930': 'Företagskonto',
  '1940': 'Övriga bankkonton',
}

export interface LedgerPickInput {
  uid: string
  currency: string
}

/**
 * Assign a 19xx account to every ticked bank account. Picks are placed first,
 * the server's presets among them, so an account without one never overflows
 * onto a slot a later account already holds. A pick wins when that slot is
 * free; otherwise the currency default, then the next overflow slot.
 * `used` are the company's existing cash-account ledgers (never handed out as
 * overflow). `connected` are the ledgers held by another bank connection: only
 * those block the currency default, see the header. Omitted, every used
 * ledger blocks it. `chart` are the company's chart account numbers, which
 * overflow reaches last, as on the server.
 */
export function allocateLedgers(
  ticked: LedgerPickInput[],
  used: Iterable<string>,
  picks: Record<string, string | undefined> = {},
  connected?: Iterable<string>,
  chart: Iterable<string> = [],
): Record<string, string> {
  const taken = new Set(used)
  const blocksDefault = connected === undefined ? new Set(taken) : new Set(connected)
  const chartNumbers = [...chart]
  const out: Record<string, string> = {}
  const assign = (uid: string, ledger: string) => {
    taken.add(ledger)
    blocksDefault.add(ledger)
    out[uid] = ledger
  }
  for (const a of ticked) {
    const pick = picks[a.uid]
    const d = CURRENCY_LEDGER_DEFAULTS[a.currency.toUpperCase()]
    if (pick && (!taken.has(pick) || (pick === d && !blocksDefault.has(pick)))) assign(a.uid, pick)
  }
  for (const a of ticked) {
    if (out[a.uid]) continue
    const d = CURRENCY_LEDGER_DEFAULTS[a.currency.toUpperCase()]
    assign(a.uid, d && !blocksDefault.has(d) ? d : overflowLedgerSlots(taken, chartNumbers)[0] ?? '1940')
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
 * The pick list for one account's Ändra row: its default first, then the
 * overflow slots. `connected` works as in {@link allocateLedgers}: when given,
 * only those ledgers keep the currency default off the list. `chart` orders
 * the overflow slots as there.
 */
export function ledgerOptions(
  currency: string,
  used: Iterable<string>,
  current: string,
  connected?: Iterable<string>,
  chart: Iterable<string> = [],
): string[] {
  const taken = new Set(used)
  taken.delete(current)
  const blocksDefault = connected === undefined ? taken : new Set(connected)
  const d = CURRENCY_LEDGER_DEFAULTS[currency.toUpperCase()] ?? '1940'
  const list = [d, ...overflowLedgerSlots(taken, chart)].filter(
    (v, i, arr) => arr.indexOf(v) === i && (v === d ? !blocksDefault.has(v) : !taken.has(v)),
  )
  if (!list.includes(current)) list.unshift(current)
  return list.slice(0, 8)
}

export function ledgerName(ledger: string, currency: string, known: Record<string, string> = {}): string {
  return known[ledger] ?? LEDGER_NAMES[ledger] ?? bankLedgerName(currency)
}
