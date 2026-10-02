/**
 * Ledger preview for the bank accounts the user ticks in onboarding, on the
 * server's own slot rule (lib/cash-accounts/ledger-slots.ts, which
 * findFreeLedgerAccount uses too): the currency default first, then the next
 * overflow slot. The currency default is blocked by a row another bank
 * connection syncs onto; a manual row on it (the 1930 every company is seeded
 * with, the bank account an SIE import brought) is promoted in place by the
 * server, so the first bank account lands on the ledger the books already use.
 * That holds only for a row the account may take over (holderAdoptableBy):
 * a manual row with another IBAN or currency is another bank account, the
 * server refuses to promote it, and the account overflows. Overflow skips
 * every existing row. The PATCH /accounts request sends this choice as an
 * explicit mapping, so the preview must be neither stricter nor looser than
 * the server.
 */

import {
  CURRENCY_LEDGER_DEFAULTS,
  bankLedgerName,
  holderAdoptableBy,
  overflowLedgerSlots,
  type SlotHolder,
} from '@/lib/cash-accounts/ledger-slots'

/** Names for the standard BAS bank accounts when the chart has none. */
export const LEDGER_NAMES: Record<string, string> = {
  '1930': 'Företagskonto',
  '1940': 'Övriga bankkonton',
}

export interface LedgerPickInput {
  uid: string
  currency: string
  /** Decides whether the account may take over a row on its currency default. */
  iban?: string | null
}

/** Whether `holders` keep `account` off `ledger`: any row there it may not take over. */
function heldAgainst(holders: readonly SlotHolder[], ledger: string, account: { currency: string; iban?: string | null }): boolean {
  return holders.some((h) => h.ledger_account === ledger && !holderAdoptableBy(h, account))
}

/**
 * Assign a 19xx account to every ticked bank account. Picks are placed first,
 * the server's presets among them, so an account without one never overflows
 * onto a slot a later account already holds. A pick wins when that slot is
 * free; otherwise the currency default, then the next overflow slot.
 * `used` are the company's existing cash-account ledgers (never handed out as
 * overflow). `connected` are the ledgers held by another bank connection:
 * they block the currency default, see the header. Omitted, every used
 * ledger blocks it. `holders` are the rows outside this connection (see
 * {@link ledgerClaims}): one an account may not take over also keeps it off
 * that account's currency default. `chart` are the company's chart account
 * numbers, which overflow reaches last, as on the server.
 */
export function allocateLedgers(
  ticked: LedgerPickInput[],
  used: Iterable<string>,
  picks: Record<string, string | undefined> = {},
  connected?: Iterable<string>,
  chart: Iterable<string> = [],
  holders: readonly SlotHolder[] = [],
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
  const defaultOpen = (a: LedgerPickInput, d: string) => !blocksDefault.has(d) && !heldAgainst(holders, d, a)
  for (const a of ticked) {
    const pick = picks[a.uid]
    const d = CURRENCY_LEDGER_DEFAULTS[a.currency.toUpperCase()]
    if (pick && (!taken.has(pick) || (pick === d && defaultOpen(a, pick)))) assign(a.uid, pick)
  }
  for (const a of ticked) {
    if (out[a.uid]) continue
    const d = CURRENCY_LEDGER_DEFAULTS[a.currency.toUpperCase()]
    assign(a.uid, d && defaultOpen(a, d) ? d : overflowLedgerSlots(taken, chartNumbers)[0] ?? '1940')
  }
  return out
}

/**
 * Split the company's cash accounts into what {@link allocateLedgers} needs,
 * seen from one bank connection: `used` is every ledger held by a row outside
 * that connection, `connected` only those another enabled bank connection
 * syncs onto, and `holders` those rows with the identity the server checks
 * before it promotes one in place. A disabled row of another connection has
 * no claim: save_bank_account_selection releases it to a manual row before it
 * promotes. Nor has a row left on a revoked connection (`bank_connection.status`,
 * as findFreeLedgerAccount and promote_psd2_cash_account read it): a
 * disconnect from before the disconnect RPC released its rows left them there.
 */
export function ledgerClaims(
  cashAccounts: ReadonlyArray<{
    ledger_account: string
    bank_connection_id: string | null
    enabled?: boolean | null
    iban?: string | null
    currency?: string
    bank_connection?: { status?: string | null } | null
  }>,
  connectionId: string | null,
): { used: string[]; connected: string[]; holders: SlotHolder[] } {
  const others = cashAccounts.filter((c) => c.bank_connection_id !== connectionId)
  const holders = others.map((c) => ({
    ledger_account: c.ledger_account,
    iban: c.iban ?? null,
    currency: c.currency ?? '',
    live: c.bank_connection_id !== null && c.enabled !== false && c.bank_connection?.status !== 'revoked',
  }))
  return {
    used: holders.map((h) => h.ledger_account),
    connected: holders.filter((h) => h.live).map((h) => h.ledger_account),
    holders,
  }
}

/**
 * The pick list for one account's Ändra row: its default first, then the
 * overflow slots. `connected` works as in {@link allocateLedgers}: when given,
 * those ledgers keep the currency default off the list, and so does a row in
 * `holders` the account (by its `iban`) may not take over. `chart` orders the
 * overflow slots as there.
 */
export function ledgerOptions(
  currency: string,
  used: Iterable<string>,
  current: string,
  connected?: Iterable<string>,
  chart: Iterable<string> = [],
  holders: readonly SlotHolder[] = [],
  iban: string | null = null,
): string[] {
  const taken = new Set(used)
  taken.delete(current)
  const blocksDefault = connected === undefined ? taken : new Set(connected)
  const d = CURRENCY_LEDGER_DEFAULTS[currency.toUpperCase()] ?? '1940'
  const defaultOpen = !blocksDefault.has(d) && !heldAgainst(holders, d, { currency, iban })
  const list = [d, ...overflowLedgerSlots(taken, chart)].filter(
    (v, i, arr) => arr.indexOf(v) === i && (v === d ? defaultOpen : !taken.has(v)),
  )
  if (!list.includes(current)) list.unshift(current)
  return list.slice(0, 8)
}

export function ledgerName(ledger: string, currency: string, known: Record<string, string> = {}): string {
  return known[ledger] ?? LEDGER_NAMES[ledger] ?? bankLedgerName(currency)
}
