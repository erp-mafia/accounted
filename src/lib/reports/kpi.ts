import type { SupabaseClient } from '@supabase/supabase-js'
import type { IncomeStatementReport, TrialBalanceRow } from '@/types'
import { VAT_INPUT_ACCOUNTS, VAT_OUTPUT_ACCOUNTS } from '@/lib/reports/vat-declaration'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

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
 * The supplier-invoice query behind "Största leverantörer", shared by the KPI
 * JSON route and the KPI xlsx export so the two can never select different
 * columns or filter different rows for the same company and period.
 */
export function topSupplierInvoicesQuery(
  supabase: SupabaseClient,
  companyId: string,
  periodStart: string,
  periodEnd: string
) {
  return supabase
    .from('supplier_invoices')
    .select('supplier_id, total, total_sek, currency, exchange_rate, supplier:suppliers(id, name)')
    .eq('company_id', companyId)
    .gte('invoice_date', periodStart)
    .lte('invoice_date', periodEnd)
    .neq('status', 'credited')
}

/**
 * Fetch ALL supplier-invoice rows for the period, paginated past PostgREST's
 * silent 1000-row cap. Awaiting `topSupplierInvoicesQuery` bare truncated the
 * input to `aggregateTopSuppliers` for companies with more than 1000 supplier
 * invoices in a fiscal year, silently corrupting the "Största leverantörer"
 * totals in both the KPI JSON route and the xlsx export.
 *
 * Ordered on `id` (the PK) purely for paging stability: aggregation is
 * order-independent, but `.range()` paging without a stable total order can
 * duplicate or skip rows on page boundaries (see lib/supabase/fetch-all.ts).
 *
 * Returns the `{ data, error }` shape the two route callers already consume,
 * so a query failure stays a reportable value rather than becoming a thrown
 * 500 (the KPI route deliberately renders the rest of the report and logs).
 */
export async function fetchTopSupplierInvoices(
  supabase: SupabaseClient,
  companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<{ data: KpiSupplierInvoiceRow[] | null; error: { message: string } | null }> {
  try {
    const rows = await fetchAllRows<KpiSupplierInvoiceRow>(({ from, to }) =>
      topSupplierInvoicesQuery(supabase, companyId, periodStart, periodEnd)
        .order('id', { ascending: true })
        .range(from, to)
    )
    return { data: rows, error: null }
  } catch (err) {
    return {
      data: null,
      error: { message: err instanceof Error ? err.message : 'Unknown error' },
    }
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
