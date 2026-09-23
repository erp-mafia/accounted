/**
 * Which single ledger line carries a manual entry's FX metadata.
 *
 * `journal_entry_lines.debit_amount / credit_amount` are ALWAYS SEK. A foreign
 * affärshändelse is converted to SEK for those columns, and the foreign figure
 * survives only as `currency` + `amount_in_currency` + `exchange_rate` stamped
 * onto ONE leg: the leg that is the foreign monetary item. That is the ÅRL
 * 4 kap. 13 § line: fordringar och skulder i utländsk valuta are what gets
 * revalued at balansdagens kurs, while a maskin, ett lager or en kostnad is
 * measured once in SEK and never revalued.
 *
 * THE GENERATORS ARE THE REFERENCE. Each puts the metadata on exactly one leg,
 * the monetary item carrying the whole document amount:
 *   lib/bookkeeping/invoice-entries.ts          → 1510, amount = invoice.total
 *   lib/bookkeeping/supplier-invoice-entries.ts → 2440, amount = invoice.total
 *   lib/bookkeeping/transaction-entries.ts      → the settlement/cash leg,
 *                                                 amount = |transaction.amount|
 * Never on a VAT leg, never on a P&L leg, never on two legs at once. Note that
 * the account prefix is NOT the rule: 1510, 2440 and 19xx all appear.
 *
 * Everything that reads the metadata back finds the line BY ACCOUNT and then
 * trusts the label, so a misplaced stamp is not cosmetic:
 *   lib/reconciliation/bank-reconciliation.ts `ledgerLineAmountIn()` reconciles
 *     a foreign cash account against `amount_in_currency` on that account's own
 *     lines. Metadata on the SEK leg instead leaves the EUR account with no
 *     comparable figure at all, and labels a SEK movement as a EUR one.
 *   lib/invoices/voucher-matching.ts narrows candidate vouchers with
 *     `journal_entry_lines.currency = invoice.currency` under the 1510/2440
 *     prefix: the metadata has to be on that leg or the voucher is invisible.
 *   lib/core/bookkeeping/storno-service.ts mirrors whatever is stored, so a
 *     wrong stamp is copied into the rättelse as well.
 *
 * This module is pure and order-independent on purpose: the caller resolves the
 * slot in a PRE-PASS over all lines and only then builds them, so the answer
 * cannot depend on which line the loop happens to reach first.
 */

import { roundOre } from '@/lib/money'

/** The subset of a form/entry line the slot decision needs. Amounts are SEK. */
export interface FxSlotLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  /** FX label already on the line (hydrated draft, agent-created entry). */
  currency?: string | null
}

export interface FxSlotInput {
  /** Entry-level currency picked in the form. 'SEK' means nothing to place. */
  entryCurrency: string
  /** SEK per 1 unit of `entryCurrency`. <= 0 means the user has no rate yet. */
  exchangeRate: number
  /** The entry's amount expressed in `entryCurrency`. */
  foreignAmount: number
}

export type FxSlotResolution =
  /** Nothing to place: SEK entry, or no usable rate/amount yet. */
  | { kind: 'none' }
  /** These lines already carry their own FX metadata: leave them alone and
   *  stamp nothing else, or two lines end up claiming the same foreign amount. */
  | { kind: 'preset'; indexes: number[] }
  /** Stamp exactly this line, and no other. */
  | { kind: 'slot'; index: number }
  /**
   * The metadata cannot be placed. The caller must REFUSE rather than drop it:
   * `journal_entries` has no currency or exchange_rate column, so a rate that
   * is not written to a line is unrecoverable afterwards.
   */
  | {
      kind: 'unplaceable'
      reason: 'no_carrier' | 'ambiguous' | 'currency_conflict'
      /** Accounts the message should name (candidates, or the conflicting leg). */
      accounts: string[]
      /** The line-level currency that conflicts with the entry currency. */
      lineCurrency?: string
    }

/**
 * BAS account conventionally denominated in a given currency. Mirrors
 * CURRENCY_LEDGER_DEFAULTS in lib/cash-accounts/service.ts; copied rather than
 * imported because this module is pulled into a client bundle and that one
 * reaches the server logger and the SIE account-sync path.
 *
 * Used ONLY to break a tie between two otherwise equal monetary legs (a
 * SEK↔EUR växling hits both legs with the same SEK amount, so the amount alone
 * cannot say which leg is the EUR one).
 */
export const CONVENTIONAL_FX_LEDGER: Record<string, string> = {
  SEK: '1930',
  EUR: '1932',
  USD: '1933',
  GBP: '1934',
}

/**
 * Monetary items in BAS terms (ÅRL 4 kap. 13 §): kassa/bank, fordringar,
 * interimsfordringar, and the liability side except eget kapital (20xx),
 * obeskattade reserver (21xx) and avsättningar (22xx).
 *
 * Deliberately excluded:
 *   10xx-14xx  anläggningstillgångar och lager: measured in SEK at acquisition,
 *              never revalued, so they never carry a foreign denomination.
 *   18xx       kortfristiga placeringar: securities, not a monetary claim.
 *   26xx       moms: Swedish VAT is settled in SEK and a VAT leg is a derived
 *              sub-amount, never the document total.
 */
const MONETARY_ACCOUNT_PREFIXES = ['15', '16', '17', '19', '23', '24', '25', '27', '28', '29']

export function isMonetaryLedgerAccount(accountNumber: string): boolean {
  return MONETARY_ACCOUNT_PREFIXES.includes(accountNumber.slice(0, 2))
}

function normalizeCurrency(currency: string | null | undefined): string {
  return (currency ?? '').trim().toUpperCase()
}

/**
 * Resolve which line carries the entry's FX metadata.
 *
 * THE RULE, in order:
 *   1. A line that already carries a non-SEK `currency` IS the FX line
 *      (hydrated draft, MCP/agent-created entry). Those lines own the
 *      metadata and nothing else is stamped. A line labelled with a DIFFERENT
 *      currency than the entry is a conflict, not something to overwrite.
 *   2. Otherwise the FX line is the monetary leg (see
 *      {@link isMonetaryLedgerAccount}) whose SEK amount equals
 *      `foreignAmount × exchangeRate`: the leg that IS the foreign amount,
 *      which is what the generators stamp. P&L and VAT legs are excluded, so a
 *      EUR supplier invoice booked 4010/2440 lands on 2440, and a EUR card
 *      purchase booked 5410/1930 lands on 1930.
 *   3. When several monetary legs match the amount (a SEK↔EUR växling books the
 *      same SEK figure on both legs), the leg on the account conventionally
 *      denominated in the entry currency wins (EUR → 1932); failing that, legs
 *      on an account conventionally denominated in ANOTHER currency (1930 =
 *      SEK) are dropped, which lands a EUR transfer on a non-default EUR
 *      account too.
 *   4. Anything still undecided is `unplaceable`. Never "first line wins":
 *      that is the order-dependence this function exists to remove.
 */
export function resolveFxLineSlot(lines: FxSlotLine[], input: FxSlotInput): FxSlotResolution {
  const entryCurrency = normalizeCurrency(input.entryCurrency) || 'SEK'
  const hasRate = Number.isFinite(input.exchangeRate) && input.exchangeRate > 0
  const hasAmount = Number.isFinite(input.foreignAmount) && input.foreignAmount > 0
  const entryIsForeign = entryCurrency !== 'SEK' && hasRate && hasAmount

  // 1. Lines that already speak for themselves.
  const preset = lines
    .map((line, index) => ({ index, line, currency: normalizeCurrency(line.currency) }))
    .filter((l) => l.currency !== '' && l.currency !== 'SEK')

  if (preset.length > 0) {
    const conflicting = entryIsForeign ? preset.filter((l) => l.currency !== entryCurrency) : []
    if (conflicting.length > 0) {
      return {
        kind: 'unplaceable',
        reason: 'currency_conflict',
        accounts: conflicting.map((l) => l.line.account_number),
        lineCurrency: conflicting[0].currency,
      }
    }
    return { kind: 'preset', indexes: preset.map((l) => l.index) }
  }

  if (!entryIsForeign) return { kind: 'none' }

  // 2. Candidates: monetary legs whose SEK amount is the foreign amount.
  //    The tolerance absorbs the double rounding on the way in: the foreign
  //    amount is itself öre-rounded, so converting it back can miss the booked
  //    SEK figure by up to half an öre times the rate.
  const expectedSek = roundOre(input.foreignAmount * input.exchangeRate)
  const tolerance = roundOre(input.exchangeRate * 0.005) + 0.01

  const candidates = lines
    .map((line, index) => ({ index, line }))
    .filter(({ line }) => normalizeCurrency(line.currency) === '')
    .filter(({ line }) => isMonetaryLedgerAccount(line.account_number))
    .filter(({ line }) => {
      const sek = roundOre(Math.abs((line.debit_amount || 0) - (line.credit_amount || 0)))
      return Math.abs(sek - expectedSek) <= tolerance
    })

  if (candidates.length === 0) {
    return {
      kind: 'unplaceable',
      reason: 'no_carrier',
      accounts: lines.map((l) => l.account_number).filter((a) => a !== ''),
    }
  }
  if (candidates.length === 1) return { kind: 'slot', index: candidates[0].index }

  // 3. Tie-break by denomination of the account itself.
  const entryCurrencyAccount = CONVENTIONAL_FX_LEDGER[entryCurrency]
  const onEntryCurrencyAccount = candidates.filter(
    (c) => c.line.account_number === entryCurrencyAccount
  )
  if (onEntryCurrencyAccount.length === 1) {
    return { kind: 'slot', index: onEntryCurrencyAccount[0].index }
  }

  if (onEntryCurrencyAccount.length === 0) {
    const otherCurrencyAccounts = new Set(
      Object.entries(CONVENTIONAL_FX_LEDGER)
        .filter(([currency]) => currency !== entryCurrency)
        .map(([, account]) => account)
    )
    const remaining = candidates.filter((c) => !otherCurrencyAccounts.has(c.line.account_number))
    if (remaining.length === 1) return { kind: 'slot', index: remaining[0].index }
  }

  // 4. Still undecided: refuse, do not guess.
  return {
    kind: 'unplaceable',
    reason: 'ambiguous',
    accounts: candidates.map((c) => c.line.account_number),
  }
}
