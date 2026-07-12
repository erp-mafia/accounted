import type { IncomeStatementReport, TrialBalanceRow } from '@/types'
import { VAT_INPUT_ACCOUNTS, VAT_OUTPUT_ACCOUNTS } from '@/lib/reports/vat-declaration'

/**
 * Calculate gross margin from income statement.
 * Gross margin = (revenue - COGS) / revenue × 100
 * COGS = class 4 expense sections (Varor och material, etc.)
 */
export function calculateGrossMargin(incomeStatement: IncomeStatementReport): number | null {
  const { total_revenue, expense_sections } = incomeStatement
  if (total_revenue === 0) return null

  // Class 4 expenses = cost of goods sold (account prefixes 40-49)
  const cogs = expense_sections
    .filter((s) => s.rows.some((r) => r.account_number.startsWith('4')))
    .reduce((sum, s) => sum + s.subtotal, 0)

  return Math.round(((total_revenue - cogs) / total_revenue) * 10000) / 100
}

/**
 * Calculate cash position from trial balance rows.
 * Sums closing balances for accounts matching 19xx (bank + cash accounts).
 */
export function calculateCashPosition(rows: TrialBalanceRow[]): number {
  const cashRows = rows.filter((r) => r.account_number.startsWith('19'))
  const total = cashRows.reduce(
    (sum, r) => sum + (r.closing_debit - r.closing_credit),
    0
  )
  return Math.round(total * 100) / 100
}

/**
 * Calculate net VAT liability (positive = att betala) or receivable
 * (negative = att återfå) from trial balance rows.
 *
 * Uses the same 26xx accounts as the momsdeklaration so the result mirrors
 * ruta 49: output VAT (rutor 10-12, 30-32, 60-62) − input VAT (ruta 48).
 * Reverse-charge and import pairs (e.g. 2614 credit + 2645 debit) therefore
 * net to zero instead of inflating the receivable (#715).
 *
 * `accounts` overrides the default list (user KPI preferences); accounts in
 * the 264x range count as input VAT, all other 26xx accounts as output VAT.
 */
export function calculateVatLiability(
  rows: TrialBalanceRow[],
  accounts?: string[]
): number {
  const vatAccounts =
    accounts && accounts.length > 0
      ? accounts
      : [...VAT_OUTPUT_ACCOUNTS, ...VAT_INPUT_ACCOUNTS]

  const outputVat = rows
    .filter(
      (r) =>
        vatAccounts.includes(r.account_number) &&
        r.account_number.startsWith('26') &&
        !r.account_number.startsWith('264')
    )
    .reduce((sum, r) => sum + (r.closing_credit - r.closing_debit), 0)
  const inputVat = rows
    .filter(
      (r) =>
        vatAccounts.includes(r.account_number) && r.account_number.startsWith('264')
    )
    .reduce((sum, r) => sum + (r.closing_debit - r.closing_credit), 0)

  return Math.round((outputVat - inputVat) * 100) / 100
}

/**
 * Calculate revenue growth between two periods.
 * Returns percentage or null if no previous period data.
 */
export function calculateRevenueGrowth(
  currentRevenue: number,
  previousRevenue: number | null
): number | null {
  if (previousRevenue === null || previousRevenue === 0) return null
  return Math.round(((currentRevenue - previousRevenue) / previousRevenue) * 10000) / 100
}

/**
 * Calculate expense ratio from income statement.
 * Expense ratio = total_expenses / total_revenue × 100
 */
export function calculateExpenseRatio(incomeStatement: IncomeStatementReport): number | null {
  const { total_revenue, total_expenses } = incomeStatement
  if (total_revenue === 0) return null
  return Math.round((total_expenses / total_revenue) * 10000) / 100
}

/**
 * Calculate average payment days from paid invoices.
 * Returns null if fewer than 5 invoices with paid_at data.
 */
export function calculateAvgPaymentDays(
  paidInvoices: { invoice_date: string; paid_at: string }[]
): number | null {
  if (paidInvoices.length < 5) return null

  const totalDays = paidInvoices.reduce((sum, inv) => {
    const invoiceDate = new Date(inv.invoice_date)
    const paidDate = new Date(inv.paid_at)
    const days = Math.floor(
      (paidDate.getTime() - invoiceDate.getTime()) / (1000 * 60 * 60 * 24)
    )
    return sum + Math.max(0, days)
  }, 0)

  return Math.round(totalDays / paidInvoices.length)
}
