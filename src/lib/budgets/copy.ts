/**
 * Last year's actuals as next year's budget.
 *
 * Each account's booked amount per month moves to the budget month with the
 * same calendar month (March to March), so a season stays a season even when
 * the two years differ in length. A calendar month the source year holds
 * twice (an 18-month year) gives its later month; a budget month the source
 * year never reached gets 0. An optional percentage change scales every
 * month, rounded to öre (roundOre).
 *
 * Every month of the budget year is answered for each account that had
 * actuals, zeros included: the grid save removes a cell whose amount is 0, so
 * copying again overwrites the account's whole year instead of leaving cells
 * of an earlier copy behind. Accounts without actuals are left alone, and so
 * is årets resultat (8990-8999).
 */
import { roundOre } from '@/lib/money'
import { isAretsResultatAccount } from '@/lib/bookkeeping/bas-data/result-accounts'
import { calendarMonthOf } from './months'
import { profileFromActuals, type MonthAmount } from './spread'

export interface AccountMonthAmount {
  account_number: string
  /** 'YYYY-MM' */
  month: string
  amount: number
}

export function copyActualsToMonths(
  actuals: readonly AccountMonthAmount[],
  budgetMonths: readonly string[],
  percentChange = 0,
): AccountMonthAmount[] {
  const factor = 1 + percentChange / 100
  const byAccount = new Map<string, MonthAmount[]>()
  for (const a of actuals) {
    // Årets resultat (8990-8999) is the omföring of last year's result to
    // equity, not a result to plan for: budgeting it would cancel the
    // budgeted result.
    if (isAretsResultatAccount(a.account_number)) continue
    const list = byAccount.get(a.account_number) ?? []
    list.push({ month: a.month, amount: a.amount })
    byAccount.set(a.account_number, list)
  }

  const out: AccountMonthAmount[] = []
  for (const account of [...byAccount.keys()].sort()) {
    const profile = profileFromActuals(byAccount.get(account)!)
    for (const month of budgetMonths) {
      const source = profile.get(calendarMonthOf(month)) ?? 0
      out.push({ account_number: account, month, amount: roundOre(source * factor) })
    }
  }
  return out
}
