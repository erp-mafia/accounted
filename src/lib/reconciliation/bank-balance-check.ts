/**
 * The bank's own balance against the books: what the bank reported at its
 * last balance refresh and the booked balance of the account the bank account
 * books on, at the end of the bank's day for that balance (bankBalanceDay).
 *
 * Why it exists next to the bridge: the bridge judges an account by its
 * movements inside a window, without the opening balance and without ignored
 * rows. A balance that never reached the books, or a real payment that was
 * ignored, therefore never shows there. Measured 2026-10-26, two in three bank
 * accounts differed from the bank's own balance, one in six of those only by
 * the opening balance or ignored rows, while their movements agreed.
 *
 * The difference is split into what the user can act on:
 *   - unbooked: bank rows through that day with no verifikat
 *     (lib/transactions/unbooked.ts's definition);
 *   - before_history: where the bank stood before its first row (its balance
 *     less every row since) against the books the day before, typically an
 *     opening balance that never reached the books. An ignored row that was a
 *     real payment lands here too: ignored rows are no movement on the bank
 *     side, as in get_bank_reconciliation_facts;
 *   - rest: what the books moved on the account since the bank's first row
 *     beyond the rows booked against it: verifikat on the account without a
 *     bank row, rows booked on another account or amount.
 * The three parts sum to the difference to the öre.
 *
 * The booked side is the balance sheet's figure (bookedBalancesAt), the same
 * one the bank_balance_vs_bank check reads (lib/unexplained/checks), so the
 * page, v1 and MCP give one answer.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import { isSaneDateString } from '@/lib/invariants/iso-date'
import { roundOre } from '@/lib/money'
import { generateTrialBalance } from '@/lib/reports/trial-balance'

export interface BankBalanceCheck {
  /** The bank's day for its balance (bankBalanceDay): both sides are read at its end. */
  as_of: string
  /** When the balance was fetched (cash_accounts.balance_updated_at). */
  fetched_at: string
  /** The bank's type for its balance (closingBooked, CLBD, expected, ...); null when it gave no day. */
  balance_type: string | null
  bank_balance: number
  /** Booked balance (debit minus credit) on the account at the end of as_of, as the balance sheet reads it. */
  booked_balance: number
  /** bank_balance - booked_balance. */
  difference: number
  /** Bank rows through as_of without a verifikat: money the bank moved and the books have not. */
  unbooked: { count: number; total: number }
  /**
   * The bank's balance before its first row through as_of (its balance less
   * every non-ignored row since) against the booked balance the day before.
   * Null when the bank has no row through as_of, or when no fiscal year holds
   * that day.
   */
  before_history: {
    history_start: string
    bank_balance: number
    booked_balance: number
    difference: number
  } | null
  /** Rows ignored through as_of: outside every sum above, counted for review. */
  ignored: { count: number; total: number }
  /** difference - unbooked.total - before_history.difference. */
  rest: number
}

export type BankBalanceCheckRefusal = 'NO_BANK_BALANCE' | 'FOREIGN_CURRENCY_ACCOUNT' | 'NO_FISCAL_PERIOD'

export type BankBalanceCheckResult =
  | { check: BankBalanceCheck; refusal: null }
  | { check: null; refusal: BankBalanceCheckRefusal }

export interface BankBalanceCheckAccount {
  id: string
  ledger_account: string
  currency: string | null
  is_primary: boolean | null
  balance: number | string | null
  balance_updated_at: string | null
  /** cash_accounts.balance_reference, as stored: read only through bankBalanceDay. */
  balance_reference: unknown
}

interface FiscalPeriodRow {
  id: string
  period_start: string
  period_end: string
}

/** roundOre, with the -0 a tiny negative rounds to read as 0. */
function ore(n: number): number {
  return roundOre(n) || 0
}

interface BankBalanceFacts {
  history_start: string | null
  rows_total: number | string
  unbooked_count: number
  unbooked_total: number | string
  ignored_count: number
  ignored_total: number | string
}

/**
 * The day a bank balance belongs to, and its type. The bank's own day when
 * the stored reference came with this very balance (its fetched_at is the
 * row's balance_updated_at) and is a real day no later than the fetch;
 * otherwise the Stockholm day of the fetch. A closingBooked balance is the
 * close of its day, often yesterday: read on the fetch day, the rows booked
 * since would count on the book side only.
 */
export function bankBalanceDay(balanceUpdatedAt: string, reference: unknown): { date: string; type: string | null } {
  const fetchDay = todayIsoStockholm(new Date(balanceUpdatedAt))
  const ref = reference !== null && typeof reference === 'object' ? (reference as Record<string, unknown>) : null
  if (
    ref &&
    typeof ref.date === 'string' &&
    isSaneDateString(ref.date) &&
    ref.date <= fetchDay &&
    typeof ref.fetched_at === 'string' &&
    Date.parse(ref.fetched_at) === Date.parse(balanceUpdatedAt)
  ) {
    return { date: ref.date, type: typeof ref.type === 'string' ? ref.type : null }
  }
  return { date: fetchDay, type: null }
}

/**
 * Booked balance (debit minus credit) of every account at the end of `date`,
 * as the balance sheet reads it: the fiscal period's opening balance plus its
 * posted and reversed verifikat through `date`, closing entry included.
 */
export async function bookedBalancesAt(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  date: string,
): Promise<Map<string, number>> {
  const tb = await generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'include', toDate: date })
  return new Map(tb.rows.map((r) => [r.account_number, roundOre(r.closing_debit - r.closing_credit)]))
}

/**
 * One account's booked balance at the end of `date`: 0 before the company's
 * first fiscal year (nothing can be booked there), null when the date falls
 * outside every fiscal year after it.
 */
async function bookedBalanceOn(
  supabase: SupabaseClient,
  companyId: string,
  periods: FiscalPeriodRow[],
  accountNumber: string,
  date: string,
): Promise<number | null> {
  const period = periods.find((p) => p.period_start <= date && date <= p.period_end)
  if (!period) {
    const first = periods.reduce<string | null>((min, p) => (min === null || p.period_start < min ? p.period_start : min), null)
    return first !== null && date < first ? 0 : null
  }
  const balances = await bookedBalancesAt(supabase, companyId, period.id, date)
  return balances.get(accountNumber) ?? 0
}

/**
 * The balance check for one bank cash account. Refuses, rather than guesses,
 * when there is no balance from the bank, when the account is kept in another
 * currency than the ledger, or when no fiscal year holds the bank's day.
 * Throws on a failed read: a balance read that failed is no balance claim.
 */
export async function checkBankBalance(
  supabase: SupabaseClient,
  companyId: string,
  account: BankBalanceCheckAccount,
): Promise<BankBalanceCheckResult> {
  if (account.balance == null || account.balance_updated_at == null) {
    return { check: null, refusal: 'NO_BANK_BALANCE' }
  }
  const bankBalance = ore(Number(account.balance))
  const day = bankBalanceDay(account.balance_updated_at, account.balance_reference)
  const asOf = day.date
  const currency = account.currency ?? 'SEK'

  const [companyRead, periodsRead, factsRead] = await Promise.all([
    supabase.from('companies').select('ledger_currency').eq('id', companyId).maybeSingle(),
    supabase.from('fiscal_periods').select('id, period_start, period_end').eq('company_id', companyId),
    supabase.rpc('get_bank_balance_facts', {
      p_company_id: companyId,
      p_cash_account_id: account.id,
      p_include_unassigned: Boolean(account.is_primary),
      p_currency: currency,
      p_through: asOf,
    }),
  ])
  if (companyRead.error) throw new Error(`Kunde inte läsa bolaget: ${companyRead.error.message}`)
  if (periodsRead.error) throw new Error(`Kunde inte läsa räkenskapsår: ${periodsRead.error.message}`)
  if (factsRead.error) throw new Error(`Kunde inte läsa bankens transaktioner: ${factsRead.error.message}`)

  const ledgerCurrency = (companyRead.data as { ledger_currency?: string | null } | null)?.ledger_currency ?? null
  if (!ledgerCurrency || currency !== ledgerCurrency) {
    return { check: null, refusal: 'FOREIGN_CURRENCY_ACCOUNT' }
  }
  const periods = (periodsRead.data ?? []) as FiscalPeriodRow[]
  if (!periods.some((p) => p.period_start <= asOf && asOf <= p.period_end)) {
    return { check: null, refusal: 'NO_FISCAL_PERIOD' }
  }
  const facts = factsRead.data as BankBalanceFacts

  const dayBefore = facts.history_start ? addDaysIso(facts.history_start, -1) : null
  const [booked, bookedBefore] = await Promise.all([
    bookedBalanceOn(supabase, companyId, periods, account.ledger_account, asOf),
    dayBefore ? bookedBalanceOn(supabase, companyId, periods, account.ledger_account, dayBefore) : Promise.resolve(null),
  ])
  // A fiscal year holds as_of (checked above), so the balance is a number.
  const bookedBalance = booked ?? 0
  const difference = ore(bankBalance - bookedBalance)
  const unbooked = { count: Number(facts.unbooked_count), total: ore(Number(facts.unbooked_total)) }

  let beforeHistory: BankBalanceCheck['before_history'] = null
  if (facts.history_start && bookedBefore !== null) {
    const bankBefore = ore(bankBalance - Number(facts.rows_total))
    beforeHistory = {
      history_start: facts.history_start,
      bank_balance: bankBefore,
      booked_balance: bookedBefore,
      difference: ore(bankBefore - bookedBefore),
    }
  }

  return {
    refusal: null,
    check: {
      as_of: asOf,
      fetched_at: account.balance_updated_at,
      balance_type: day.type,
      bank_balance: bankBalance,
      booked_balance: bookedBalance,
      difference,
      unbooked,
      before_history: beforeHistory,
      ignored: { count: Number(facts.ignored_count), total: ore(Number(facts.ignored_total)) },
      rest: ore(difference - unbooked.total - (beforeHistory?.difference ?? 0)),
    },
  }
}
