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
 * 17xx account suggestBalanceAccount picks. Only the forms suggest this way;
 * an API caller that omits the account keeps the 17xx default.
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
 * anything else a förutbetald intäkt on 2970. Only the forms suggest this
 * way; an API caller that omits the account keeps the 2970 default.
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
 * The balance account after a periodisering panel edit. An account the user
 * picks stands. Moving the dates re-suggests only when the period crosses the
 * line between the two kinds (deferral from the invoice month on, upplupen
 * post before it).
 */
function balanceAccountAfterEdit(
  direction: AccrualDirection,
  suggest: (periodEnd: string) => string,
  previous: { start: string; end: string; balanceAccount: string },
  next: { start: string; end: string; balanceAccount: string },
): string {
  if (next.balanceAccount !== previous.balanceAccount) return next.balanceAccount
  if (next.start === previous.start && next.end === previous.end) return next.balanceAccount
  const suggested = suggest(next.end)
  return isAccruedBalanceAccount(direction, suggested) === isAccruedBalanceAccount(direction, next.balanceAccount)
    ? next.balanceAccount
    : suggested
}

/**
 * The balance account after the user edits a supplier-invoice line's
 * periodisering panel: a 17xx account moves to the 29xx suggestion once the
 * period lies wholly before the invoice month, and a 29xx account moves back
 * to the 17xx suggestion once it reaches that month.
 */
export function expenseBalanceAccountAfterEdit(
  previous: { start: string; end: string; balanceAccount: string },
  next: { start: string; end: string; balanceAccount: string },
  targetAccount: string,
  invoiceDate: string | null | undefined,
): string {
  return balanceAccountAfterEdit(
    'expense',
    (periodEnd) => suggestExpenseBalanceAccount(targetAccount, periodEnd, invoiceDate),
    previous,
    next,
  )
}

/**
 * The same for a customer-invoice line: a 29xx account moves to the 17xx
 * (upplupen intäkt) suggestion once the period lies wholly before the invoice
 * month, and back to 2970 once it reaches that month.
 */
export function revenueBalanceAccountAfterEdit(
  previous: { start: string; end: string; balanceAccount: string },
  next: { start: string; end: string; balanceAccount: string },
  invoiceDate: string | null | undefined,
): string {
  return balanceAccountAfterEdit(
    'revenue',
    (periodEnd) => suggestRevenueBalanceAccount(periodEnd, invoiceDate),
    previous,
    next,
  )
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
