/**
 * Default interim (balance) account per P&L account for periodisering.
 *
 * Förutbetalda kostnader sit on 17xx interimsfordringar; the specific account
 * follows BAS convention by cost type. Upplupna kostnader (a cost for months
 * before the invoice month) sit on 29xx interimsskulder, by default 2990.
 * Förutbetalda intäkter sit on 2970 (29xx interimsskulder); upplupna intäkter
 * (revenue for months before the invoice month) on 17xx interimsfordringar,
 * by default 1790. The user can always override in the form: these are
 * suggestions, and the DB CHECK only enforces the 17xx/29xx range.
 */

import type { AccrualDirection } from '@/types'
import { isIsoDateShaped } from '@/lib/invariants/iso-date'

export const DEFAULT_PREPAID_EXPENSE_ACCOUNT = '1790' // Övriga förutbetalda kostnader och upplupna intäkter
export const DEFAULT_ACCRUED_EXPENSE_ACCOUNT = '2990' // Övriga upplupna kostnader
export const DEFAULT_DEFERRED_REVENUE_ACCOUNT = '2970' // Förutbetalda intäkter
// BAS 1790 Övriga förutbetalda kostnader och upplupna intäkter: the same
// catch-all account serves both kinds of interimsfordran.
export const DEFAULT_ACCRUED_REVENUE_ACCOUNT = DEFAULT_PREPAID_EXPENSE_ACCOUNT

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

/**
 * An expense periodisering on a 29xx account is an upplupen kostnad: the
 * cost of months before the invoice month, booked on the last day of each
 * month and cleared by the registration on the invoice date.
 */
export function isAccruedCostAccount(account: string | null | undefined): boolean {
  return typeof account === 'string' && /^29\d{2}$/.test(account)
}

/**
 * A revenue periodisering on a 17xx account is an upplupen intäkt: revenue
 * earned in months before the invoice month, booked on the last day of each
 * month (Dr 17xx / Cr revenue, no moms) and cleared by the invoice, which
 * credits 17xx instead of the revenue account on the invoice date.
 */
export function isAccruedIncomeAccount(account: string | null | undefined): boolean {
  return typeof account === 'string' && /^17\d{2}$/.test(account)
}

/** Any interim account a periodisering can use, 17xx or 29xx. */
export function isInterimBalanceAccount(account: string | null | undefined): boolean {
  return isAccruedCostAccount(account) || isAccruedIncomeAccount(account)
}

/**
 * True for an upplupen post in either direction (a cost on 29xx, revenue on
 * 17xx): its months lie before the invoice and each books on its own last
 * day; everything else is a deferral released from the invoice on.
 */
export function isAccruedBalanceAccount(
  direction: AccrualDirection,
  account: string | null | undefined,
): boolean {
  return direction === 'expense' ? isAccruedCostAccount(account) : isAccruedIncomeAccount(account)
}

/**
 * True when a service period ends before the calendar month of invoiceDate.
 * Compares ISO strings only, so a malformed date never throws here.
 */
export function periodEndsBeforeInvoiceMonth(periodEnd: string, invoiceDate: string): boolean {
  return periodEnd < `${invoiceDate.slice(0, 7)}-01`
}

function isIsoDate(value: string | null | undefined): value is string {
  return isIsoDateShaped(value)
}

/**
 * The interim account a supplier-invoice line's periodisering suggests: a
 * period wholly before the invoice month is an upplupen kostnad (2960 for
 * räntekostnader 84xx, else 2990), anything else a förutbetald kostnad on the
 * 17xx account suggestBalanceAccount picks. The forms suggest it and the
 * write paths apply it when a caller omits the account (accounted#113).
 */
export function suggestExpenseBalanceAccount(
  targetAccount: string,
  periodEnd: string | null | undefined,
  invoiceDate: string | null | undefined,
): string {
  if (isIsoDate(periodEnd) && isIsoDate(invoiceDate) && periodEndsBeforeInvoiceMonth(periodEnd, invoiceDate)) {
    return targetAccount.startsWith('84') ? '2960' : DEFAULT_ACCRUED_EXPENSE_ACCOUNT
  }
  return suggestBalanceAccount('expense', targetAccount)
}

/**
 * The interim account a customer-invoice line's periodisering suggests: a
 * period wholly before the invoice month is an upplupen intäkt on 1790,
 * anything else a förutbetald intäkt on 2970. The form suggests it and the
 * write path applies it when a caller omits the account (accounted#113).
 */
export function suggestRevenueBalanceAccount(
  periodEnd: string | null | undefined,
  invoiceDate: string | null | undefined,
): string {
  if (isIsoDate(periodEnd) && isIsoDate(invoiceDate) && periodEndsBeforeInvoiceMonth(periodEnd, invoiceDate)) {
    return DEFAULT_ACCRUED_REVENUE_ACCOUNT
  }
  return DEFAULT_DEFERRED_REVENUE_ACCOUNT
}

/**
 * The account a periodisering line should use instead, when it defers
 * (förutbetald: a cost on 17xx, revenue on 29xx) a period that ends before
 * the invoice month; null when the line is fine. Those months are over when
 * the invoice arrives: their cost is an upplupen kostnad and their revenue
 * an upplupen intäkt, each booked in its own month. A deferral would instead
 * release every one of them on the invoice date (accounted#113). A missing
 * account counts as the deferral the booking falls back to
 * (resolveBookingAccount). A period that reaches the invoice month is a
 * deferral of that month on and stays as it is.
 */
export function pastPeriodDeferralSuggestion(
  line: { direction: AccrualDirection; targetAccount?: string | null },
  balanceAccount: string | null | undefined,
  periodEnd: string | null | undefined,
  invoiceDate: string | null | undefined,
): string | null {
  if (!isIsoDate(periodEnd) || !isIsoDate(invoiceDate)) return null
  if (!periodEndsBeforeInvoiceMonth(periodEnd, invoiceDate)) return null
  if (isAccruedBalanceAccount(line.direction, balanceAccount)) return null
  return line.direction === 'revenue'
    ? suggestRevenueBalanceAccount(periodEnd, invoiceDate)
    : suggestExpenseBalanceAccount(line.targetAccount ?? '', periodEnd, invoiceDate)
}

/** A periodisering panel's period and interim account, as the form holds them. */
export interface AccrualPanelValue {
  start: string
  end: string
  balanceAccount: string
}

/**
 * A periodisering panel's value after one edit (`patch`). An account the user
 * picks stands. Moving the dates re-suggests the account only when the period
 * crosses the line between the two kinds (deferral from the invoice month on,
 * upplupen post before it): suggestRevenueBalanceAccount for a customer
 * invoice line, suggestExpenseBalanceAccount (by the line's `targetAccount`)
 * for a supplier invoice line.
 *
 * `value` must be the value the panel rendered with, never a form row read
 * after the edit was written: react-hook-form's watch() hands out the live
 * row, which then already holds the new dates, so nothing moves (#112).
 * AccrualPeriodControl applies this to its own `value` prop for that reason.
 */
export function accrualValueAfterEdit(
  line: { direction: AccrualDirection; targetAccount?: string | null; invoiceDate?: string | null },
  value: AccrualPanelValue,
  patch: Partial<AccrualPanelValue>,
): AccrualPanelValue {
  const next = { ...value, ...patch }
  if (next.balanceAccount !== value.balanceAccount) return next
  if (next.start === value.start && next.end === value.end) return next
  const suggested =
    line.direction === 'revenue'
      ? suggestRevenueBalanceAccount(next.end, line.invoiceDate)
      : suggestExpenseBalanceAccount(line.targetAccount ?? '', next.end, line.invoiceDate)
  return isAccruedBalanceAccount(line.direction, suggested) ===
    isAccruedBalanceAccount(line.direction, next.balanceAccount)
    ? next
    : { ...next, balanceAccount: suggested }
}

/**
 * DB CHECK mirror: 17xx or 29xx in both directions. For a cost 17xx is
 * förutbetald and 29xx upplupen; for revenue 29xx is förutbetald and 17xx
 * upplupen.
 */
export function isValidBalanceAccount(
  _direction: AccrualDirection,
  account: string,
): boolean {
  return /^(17|29)\d{2}$/.test(account)
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
