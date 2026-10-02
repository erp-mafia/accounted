/**
 * Which 19xx account a bank account books on, which existing row it may take
 * over, and what a new chart row for it is called. One rule for the server
 * allocation (findFreeLedgerAccount and the chart writers in
 * lib/cash-accounts) and the onboarding preview (lib/onboarding-books/ledger.ts),
 * which sends its choice as an explicit mapping. Pure, so the client bundle
 * can import it: a separate client copy drifted once and put SEK accounts on
 * 1932 named "Bankkonto EUR".
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
 * Normalize an IBAN for comparison: ASPSPs format the same account both as
 * "SE45 5000 0000 0583 9825 7466" and "SE4550000000058398257466", and a plain
 * string compare would read those as two different accounts. Mirrors the
 * normalization the sync path already applies when deriving external_ids.
 */
export function normalizeIban(iban: string | null | undefined): string | null {
  if (!iban) return null
  const normalized = iban.replace(/\s+/g, '').toUpperCase()
  return normalized || null
}

/** A cash_accounts row that already holds a 19xx slot. */
export interface SlotHolder {
  ledger_account: string
  iban: string | null
  currency: string
  /**
   * A live bank connection syncs onto the row. Its claim blocks every other
   * account. A manual row, or one left on a revoked connection, has no claim
   * and can be promoted in place, but only to the same physical account.
   */
  live: boolean
}

/**
 * Whether a bank account (`want`) may take over the slot `holder` sits on,
 * promoting that row in place. The database decides this in
 * promote_psd2_cash_account (supabase/migrations/20260921173226_guard_bank_booking_context.sql):
 * a holder in another currency, or with an IBAN other than the account's own,
 * is a different physical account and the promotion raises
 * CASH_ACCOUNT_KEEPER_IDENTITY_CONFLICT; a live claim raises
 * CASH_ACCOUNT_LEDGER_CLAIMED. This is that rule, restated for the allocator
 * and the onboarding preview so neither proposes a slot the database refuses.
 * An account with no IBAN can only take over a holder with none either.
 */
export function holderAdoptableBy(
  holder: Pick<SlotHolder, 'iban' | 'currency' | 'live'>,
  want: { iban?: string | null; currency: string },
): boolean {
  if (holder.live) return false
  // The database compares the stored currency with the upper-cased input.
  if (holder.currency !== want.currency.toUpperCase()) return false
  const held = normalizeIban(holder.iban)
  return held === null || held === normalizeIban(want.iban)
}

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
