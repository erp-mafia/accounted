/**
 * Default interim (balance) account per P&L account for periodisering.
 *
 * Förutbetalda kostnader sit on 17xx interimsfordringar; the specific account
 * follows BAS convention by cost type. Förutbetalda intäkter sit on 2970
 * (29xx interimsskulder). The user can always override in the form: these
 * are suggestions, and the DB CHECK only enforces the 17xx/29xx range.
 */

import type { AccrualDirection } from '@/types'

export const DEFAULT_PREPAID_EXPENSE_ACCOUNT = '1790' // Övriga förutbetalda kostnader och upplupna intäkter
export const DEFAULT_DEFERRED_REVENUE_ACCOUNT = '2970' // Förutbetalda intäkter

/** Suggest the interim account for a deferred line booked to targetAccount. */
export function suggestBalanceAccount(
  direction: AccrualDirection,
  targetAccount: string,
): string {
  if (direction === 'revenue') {
    return DEFAULT_DEFERRED_REVENUE_ACCOUNT
  }
  // Hyror (lokalkostnader 50xx) → 1710 Förutbetalda hyreskostnader
  if (targetAccount.startsWith('50')) return '1710'
  // Hyra/leasing av anläggningstillgångar (52xx) and leasing personbilar
  // (5615) → 1720 Förutbetalda leasingavgifter
  if (targetAccount.startsWith('52') || targetAccount === '5615') return '1720'
  // Försäkringar (63xx, primarily 6310) → 1730 Förutbetalda försäkringspremier
  if (targetAccount.startsWith('63')) return '1730'
  // Räntekostnader (84xx) → 1740 Förutbetalda räntekostnader
  if (targetAccount.startsWith('84')) return '1740'
  return DEFAULT_PREPAID_EXPENSE_ACCOUNT
}

/** DB CHECK mirror: 17xx for expense schedules, 29xx for revenue schedules. */
export function isValidBalanceAccount(
  direction: AccrualDirection,
  account: string,
): boolean {
  return direction === 'expense' ? /^17\d{2}$/.test(account) : /^29\d{2}$/.test(account)
}

interface AccrualItemFields {
  accrual_period_start?: string | null
  accrual_period_end?: string | null
  accrual_balance_account?: string | null
}

/** True when the line carries a complete periodisering period. */
export function itemHasAccrual(item: AccrualItemFields): boolean {
  return Boolean(item.accrual_period_start && item.accrual_period_end)
}

/**
 * The account a line's net amount is actually booked to: the interim account
 * for deferred lines, otherwise the line's own P&L account. Used by the
 * entry generators so VAT/AP/AR lines stay untouched while the net moves to
 * 17xx/29xx.
 */
export function resolveBookingAccount(
  direction: AccrualDirection,
  item: AccrualItemFields,
  plAccount: string,
): string {
  if (!itemHasAccrual(item)) return plAccount
  return item.accrual_balance_account ?? suggestBalanceAccount(direction, plAccount)
}
