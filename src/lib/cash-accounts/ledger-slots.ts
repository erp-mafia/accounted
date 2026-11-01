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

/** A row or a bank's account without a currency is in SEK, the column default. */
export function currencyKey(currency: string | null | undefined): string {
  return (currency?.trim() || 'SEK').toUpperCase()
}

/**
 * Identity of the physical bank account a row represents: normalized IBAN
 * plus currency, or null for rows without an IBAN (manual, CSV, kassa). The
 * one spelling of "same IBAN, same currency" for cash_accounts rows and for
 * the accounts a bank reports; public.normalize_iban is the SQL side.
 */
export function physicalAccountKey(row: { iban?: string | null; currency?: string | null }): string | null {
  const iban = normalizeIban(row.iban)
  return iban ? `${iban}|${currencyKey(row.currency)}` : null
}

/**
 * Whether two cash_accounts row ids may be the same bank account, for the
 * content-dedup account guard in lib/transactions/ingest.ts and the booking
 * guard in lib/transactions/booking-duplicate-detection.ts.
 *
 * A null id on either side stays compatible (legacy rows without a binding).
 * Two different ids are the same account only when BOTH rows carry a physical
 * key and the keys are equal: a broken reconnect leaves two rows for one
 * (IBAN, currency), and a merge legitimately keeps the retired one as a manual
 * row while booked transactions remain on it. A row WITHOUT a key (manual, CSV,
 * kassa) never matches another id: a missing IBAN is not evidence of identity.
 *
 * @param physicalKeyById row id -> physicalAccountKey, rows without a key omitted
 */
export function sameCashAccount(
  a: string | null,
  b: string | null,
  physicalKeyById: ReadonlyMap<string, string>,
): boolean {
  if (a === null || b === null || a === b) return true
  const keyA = physicalKeyById.get(a)
  return keyA !== undefined && keyA === physicalKeyById.get(b)
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

/** One account of a bank consent, as the allocator sees it. */
export interface ConsentAccountRef {
  iban?: string | null
  bban?: string | null
  currency: string
}

/** The payment details onboarding writes on the seeded row: the company's own bank account. */
export interface PaymentDetails {
  clearing_number?: string | null
  account_number?: string | null
}

const digitsOf = (value: string | null | undefined): string => (value ?? '').replace(/\D/g, '')

/**
 * The digit runs payment details name: clearing plus account number, and the
 * account number alone (Handelsbanken's IBAN carries no clearing number). A
 * clearing number typed into the account field as well is taken out once.
 * Short runs are dropped: they would match some other account by chance.
 */
function paymentDetailRuns(details: PaymentDetails): string[] {
  const clearing = digitsOf(details.clearing_number)
  let account = digitsOf(details.account_number)
  if (clearing && account.length > clearing.length && account.startsWith(clearing)) {
    account = account.slice(clearing.length)
  }
  const runs: string[] = []
  if (clearing && account && clearing.length + account.length >= 8) runs.push(clearing + account)
  if (account.length >= 7) runs.push(account)
  return runs
}

/**
 * Whether payment details point at this bank account: one of their digit runs
 * appears in the account's IBAN (after country and check digits) or BBAN. A
 * run is matched anywhere, not only at the end, so details typed with a digit
 * or two missing still find their account; the caller only acts on a match
 * that is unique within the consent.
 */
export function paymentDetailsPointAt(details: PaymentDetails, account: ConsentAccountRef): boolean {
  const runs = paymentDetailRuns(details)
  if (runs.length === 0) return false
  const iban = normalizeIban(account.iban)
  const haystacks = [iban ? digitsOf(iban.slice(4)) : '', digitsOf(account.bban)].filter(Boolean)
  return runs.some((run) => haystacks.some((digits) => digits.includes(run)))
}

function sameConsentAccount(a: ConsentAccountRef, b: ConsentAccountRef): boolean {
  if (a.currency.toUpperCase() !== b.currency.toUpperCase()) return false
  const ibanA = normalizeIban(a.iban)
  const ibanB = normalizeIban(b.iban)
  if (ibanA && ibanB) return ibanA === ibanB
  const bbanA = digitsOf(a.bban)
  return bbanA !== '' && bbanA === digitsOf(b.bban)
}

/**
 * Whether the seeded row (no IBAN of its own) belongs to ANOTHER account of
 * the same consent than `want`: its onboarding payment details point at
 * exactly one same-currency account in `consent`, and that is not `want`.
 * Then `want` leaves the row, and its ledger, to that account. With no match,
 * or more than one, the first account to ask takes the row as before
 * (crm#1498: the empty second account took 1930 and the company's own
 * account, the one the details named, overflowed).
 */
export function seededRowBelongsToAnother(
  holder: PaymentDetails & { iban: string | null; currency: string },
  want: ConsentAccountRef,
  consent: readonly ConsentAccountRef[],
): boolean {
  if (normalizeIban(holder.iban) !== null) return false
  const matches = consent.filter(
    (account) => account.currency.toUpperCase() === holder.currency && paymentDetailsPointAt(holder, account),
  )
  if (matches.length !== 1) return false
  return !sameConsentAccount(matches[0], want)
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
