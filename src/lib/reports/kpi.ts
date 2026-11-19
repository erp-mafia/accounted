import type { SupabaseClient } from '@supabase/supabase-js'
import type { IncomeStatementReport, TrialBalanceRow } from '@/types'
import { VAT_INPUT_ACCOUNTS, VAT_OUTPUT_ACCOUNTS } from '@/lib/reports/vat-declaration'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { dbError } from '@/lib/errors/db-error'
import { todayIsoStockholm } from '@/lib/dates/iso'

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
 *
 * `accounts` overrides the default 19xx range (user KPI preferences, the
 * `cashPosition` account override), mirroring calculateVatLiability.
 */
export function calculateCashPosition(rows: TrialBalanceRow[], accounts?: string[]): number {
  const total = cashPositionRows(rows, accounts).reduce(
    (sum, r) => sum + (r.closing_debit - r.closing_credit),
    0
  )
  return Math.round(total * 100) / 100
}

/**
 * The trial balance rows the cash position sums: the `accounts` override when
 * set, else every 19xx account. Exported so a breakdown of the figure (the
 * liquid_funds measure, lib/measures) lists exactly the rows the figure adds.
 */
export function cashPositionRows(rows: TrialBalanceRow[], accounts?: string[]): TrialBalanceRow[] {
  return accounts && accounts.length > 0
    ? rows.filter((r) => accounts.includes(r.account_number))
    : rows.filter((r) => r.account_number.startsWith('19'))
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
 * Calculate expense ratio from income statement.
 * Expense ratio = total_expenses / total_revenue × 100
 */
export function calculateExpenseRatio(incomeStatement: IncomeStatementReport): number | null {
  const { total_revenue, total_expenses } = incomeStatement
  if (total_revenue === 0) return null
  return Math.round((total_expenses / total_revenue) * 10000) / 100
}

/** Supplier-invoice shape the KPI top-suppliers panel reads. */
export interface KpiSupplierInvoiceRow {
  supplier_id: string | null
  total: number | null
  total_sek: number | null
  currency: string | null
  exchange_rate: number | null
  supplier: { id: string; name: string } | { id: string; name: string }[] | null
}

export interface TopSuppliersAggregate {
  suppliers: { supplier_id: string; supplier_name: string; total: number }[]
  /**
   * Foreign-currency invoices left out of the SEK totals because they carry
   * neither a stored SEK total nor an exchange rate. Mirrors
   * `unconverted_fx_count` in lib/reports/supplier-ledger.ts: an excluded row
   * is reported, never silently dropped.
   */
  unconvertedFxCount: number
}

/** Default size of the "Största leverantörer" list. */
export const TOP_SUPPLIERS_LIMIT = 7

/**
 * The period's supplier invoices behind "Största leverantörer" (credited ones
 * left out), in one read: get_kpi_supplier_invoices
 * (supabase/migrations/20261023094020_kpi_invoice_reads.sql) returns them as
 * one json array, so PostgREST's 1000-row cap cannot truncate them. Paging
 * the rows used to take one round trip per 1000 invoices.
 *
 * In id order: aggregateTopSuppliers' float sums and its first-seen order
 * for ties depend on the order, and it has always been id order.
 *
 * Returns the `{ data, error }` shape the KPI report consumes, so a query
 * failure stays a reportable value rather than becoming a thrown 500 (the KPI
 * route deliberately renders the rest of the report and logs).
 */
export async function fetchTopSupplierInvoices(
  supabase: SupabaseClient,
  companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<{ data: KpiSupplierInvoiceRow[] | null; error: { message: string } | null }> {
  const { data, error } = await supabase.rpc('get_kpi_supplier_invoices', {
    p_company_id: companyId,
    p_from: periodStart,
    p_to: periodEnd,
  })
  if (error) return { data: null, error: { message: error.message || 'Unknown error' } }
  const rows = (Array.isArray(data) ? data : []) as {
    supplier_id: string | null
    supplier_name: string | null
    total: number | null
    total_sek: number | null
    currency: string | null
    exchange_rate: number | null
  }[]
  return {
    data: rows.map((row) => ({
      supplier_id: row.supplier_id,
      total: row.total,
      total_sek: row.total_sek,
      currency: row.currency,
      exchange_rate: row.exchange_rate,
      supplier: row.supplier_id && row.supplier_name != null ? { id: row.supplier_id, name: row.supplier_name } : null,
    })),
    error: null,
  }
}

/**
 * Aggregate supplier spend per supplier, in SEK, largest first.
 *
 * `total_sek` is only populated for invoices that went through a currency
 * conversion, so it is NULL on essentially every ordinary Swedish supplier
 * invoice. Reading it alone therefore emptied the panel for normal companies.
 * The SEK amount is resolved per row instead:
 *   - SEK invoice: `total` is the SEK total, exactly (no approximation).
 *   - Foreign invoice with a stored `total_sek` or an `exchange_rate`: convert.
 *   - Foreign invoice with neither: not expressible in SEK, so it is counted in
 *     `unconvertedFxCount` rather than added at its raw foreign amount (which
 *     would understate or inflate the supplier) or dropped without a trace.
 */
export function aggregateTopSuppliers(
  rows: KpiSupplierInvoiceRow[],
  limit: number = TOP_SUPPLIERS_LIMIT
): TopSuppliersAggregate {
  const totals = new Map<string, { name: string; total: number }>()
  let unconvertedFxCount = 0

  for (const row of rows) {
    if (!row.supplier_id) continue
    const supplier = Array.isArray(row.supplier) ? row.supplier[0] : row.supplier
    if (!supplier?.name) continue

    const rate = row.exchange_rate != null ? Number(row.exchange_rate) : null
    const isFx = !!row.currency && row.currency !== 'SEK'
    if (isFx && row.total_sek == null && !(rate != null && rate > 0)) {
      unconvertedFxCount += 1
      continue
    }

    const amount = resolveSekAmount(Number(row.total ?? 0), row.total_sek, row.currency, rate)

    const existing = totals.get(row.supplier_id)
    if (existing) existing.total += amount
    else totals.set(row.supplier_id, { name: supplier.name, total: amount })
  }

  const suppliers = Array.from(totals.entries())
    .map(([supplier_id, v]) => ({
      supplier_id,
      supplier_name: v.name,
      total: Math.round(v.total * 100) / 100,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)

  return { suppliers, unconvertedFxCount }
}

/**
 * Paid customer invoices whose payment landed inside a range, and the sum of
 * their payment days: whole days from the invoice date to paid_at, floored,
 * never negative. Counted and summed in SQL (get_paid_invoice_days).
 */
export interface PaymentDaysTotals {
  invoiceCount: number
  totalDays: number
}

/**
 * Average payment days: the total over the count, rounded. Null below five
 * paid invoices, too few to say anything.
 */
export function averagePaymentDays(totals: PaymentDaysTotals): number | null {
  if (totals.invoiceCount < 5) return null
  return Math.round(totals.totalDays / totals.invoiceCount)
}

/**
 * The company's KPI account overrides (cashPosition, vatLiability), `{}`
 * when none are stored. Shared by the KPI route and the MCP KPI tool so both
 * read the same overrides: the MCP tool used to ignore them, so an agent
 * could report a different cash position than the page. Only the overrides
 * affect figures; visibility and order are display preferences.
 */
export async function fetchKpiAccountOverrides(
  supabase: SupabaseClient,
  companyId: string
): Promise<Record<string, string[]>> {
  const { data } = await supabase
    .from('extension_data')
    .select('value')
    .eq('company_id', companyId)
    .eq('extension_id', 'core/kpi')
    .eq('key', 'preferences')
    .single()
  const value = data?.value as { accountOverrides?: Record<string, string[]> } | null | undefined
  return value?.accountOverrides ?? {}
}

/**
 * The date the receivables KPI is measured at: the report range end when it
 * lies in the past, otherwise undefined (live open-invoice state). Without
 * it a report for last year showed today's receivables.
 */
export function kpiReceivablesAsOf(rangeEnd: string, today: string = todayIsoStockholm()): string | undefined {
  return rangeEnd < today ? rangeEnd : undefined
}

function nextIsoDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * The payment days of the paid customer invoices whose payment landed inside
 * the range, for the average payment days KPI. Scoped to the range so the
 * figure describes the reported period, not every invoice the company ever
 * had paid. One read: get_paid_invoice_days
 * (supabase/migrations/20261023094020_kpi_invoice_reads.sql) counts and sums
 * in SQL instead of paging every paid invoice. Throws on a failed read.
 */
export async function fetchPaymentDaysInRange(
  supabase: SupabaseClient,
  companyId: string,
  fromDate: string,
  toDate: string
): Promise<PaymentDaysTotals> {
  const { data, error } = await supabase.rpc('get_paid_invoice_days', {
    p_company_id: companyId,
    p_from: fromDate,
    p_paid_before: nextIsoDate(toDate),
  })
  if (error) throw dbError(error, 'get_paid_invoice_days failed')
  const totals = (data ?? {}) as { invoice_count?: unknown; total_days?: unknown }
  return {
    invoiceCount: Number(totals.invoice_count) || 0,
    totalDays: Number(totals.total_days) || 0,
  }
}
