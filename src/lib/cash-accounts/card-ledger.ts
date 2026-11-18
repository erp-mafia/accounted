/**
 * Company cards (företagskort): which liability account a card books on.
 *
 * A card is a cash account of kind 'card' (migration 20261028090000). Its
 * statement rows book against the card's own ledger the way a bank row books
 * against its 19xx account: a purchase D cost / K card, the monthly payment
 * D card / K bank. The ledger is the debt to the issuer, so it lives on the
 * liability side:
 *
 *   2890, 2894, 2896, 2899   övriga kortfristiga skulder (BAS 2026)
 *   2480-2489                kontokredit, kortfristig
 *
 * 2893 (skulder till närstående) and the other 289x accounts carry their own
 * BAS meanings and are never a card. The same allowlist is the database
 * CHECK cash_accounts_card_shape, so a cash account on any of these ledgers
 * is a card and nothing else.
 *
 * Pure and dependency free: the server (manage.ts) and the add-card dialog
 * share it.
 */
import type { CashAccount } from '@/types'

/** The ledgers a card may book on; mirrors the cash_accounts_card_shape CHECK. */
export const CARD_LEDGER_PATTERN = /^(248\d|289[0469])$/

/** A cash ledger (BAS 19xx) or a card ledger: what a statement row may settle on. */
export const CASH_OR_CARD_LEDGER_PATTERN = /^(19\d{2}|248\d|289[0469])$/

/** The card ledgers in words, for messages. */
export const CARD_LEDGER_RANGE_TEXT = '2480-2489, 2890, 2894, 2896 eller 2899'

/**
 * Suggestion order: 2890 first (the account Fortnox gives its own card), then
 * 2899 (Bokio's), the other two free 289x accounts and finally kontokredit.
 */
export const CARD_LEDGER_ORDER: readonly string[] = [
  '2890',
  '2899',
  '2894',
  '2896',
  ...Array.from({ length: 10 }, (_, n) => `248${n}`),
]

/** A ledger a company card may book on (a string, never a number). */
export function isCardLedgerAccount(account: string | null | undefined): account is string {
  return !!account && CARD_LEDGER_PATTERN.test(account)
}

/** Whether a cash account row is a company card. A row without kind is a bank row. */
export function isCardCashAccount(account: Pick<CashAccount, 'kind'> | null | undefined): boolean {
  return account?.kind === 'card'
}

/** The ledgers of the company's cards, in list order. */
export function cardLedgersOf(
  accounts: ReadonlyArray<Pick<CashAccount, 'kind' | 'ledger_account'>>,
): string[] {
  return accounts.filter(isCardCashAccount).map((account) => account.ledger_account)
}

/** What the company has already booked on a candidate ledger. */
export interface CardLedgerUsage {
  /** Journal lines on the account (any status): other verifikat use it. */
  lines: number
  /** The account's saldo, debit positive; a card debt is negative. Absent when not read. */
  balance?: number
}

export interface CardLedgerSuggestion {
  /** The ledger the dialog prefills, or null when every candidate is taken. */
  ledger: string | null
  /**
   * The first candidate in the order that is free but already carries other
   * verifikat (usually 2890 as a catch-all), when the suggestion skipped it.
   * The dialog says why the card got another account and offers it anyway,
   * for a company whose 2890 already holds this card's debt.
   */
  skipped: ({ ledger: string } & CardLedgerUsage) | null
}

/**
 * The ledger a new card gets: the first candidate in CARD_LEDGER_ORDER that
 * no other cash account holds and no verifikat uses, so the card's ledger
 * carries the card alone and its balance can be reconciled with the
 * statement. 2890 is suggested only when it is unused (product decision
 * 2026-10-27); a company that already keeps this card's debt there confirms
 * it in the dialog. When every free candidate is in use, the first free one
 * is suggested and reported as skipped too, so the dialog still explains.
 */
export function suggestCardLedger(input: {
  /** Ledgers another cash account of the company holds. */
  taken: Iterable<string>
  /** Usage per candidate ledger; a ledger missing here is unused. */
  usage: Readonly<Record<string, CardLedgerUsage | undefined>>
}): CardLedgerSuggestion {
  const taken = new Set(input.taken)
  const free = CARD_LEDGER_ORDER.filter((ledger) => !taken.has(ledger))
  if (free.length === 0) return { ledger: null, skipped: null }

  const used = (ledger: string) => (input.usage[ledger]?.lines ?? 0) > 0
  const firstUsed = free.find(used)
  const unused = free.find((ledger) => !used(ledger))
  const skippedOf = (ledger: string) => ({ ledger, lines: 0, ...input.usage[ledger] })

  if (unused === undefined) return { ledger: free[0], skipped: skippedOf(free[0]) }
  // Only a used ledger ahead of the suggestion was skipped.
  const skipped = firstUsed !== undefined && free.indexOf(firstUsed) < free.indexOf(unused)
    ? skippedOf(firstUsed)
    : null
  return { ledger: unused, skipped }
}
