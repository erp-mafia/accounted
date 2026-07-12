import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { generateMonthlyBreakdown } from '@/lib/reports/monthly-breakdown'
import {
  calculateCashPosition,
  calculateGrossMargin,
  calculateExpenseRatio,
  calculateAvgPaymentDays,
  calculateVatLiability,
} from '@/lib/reports/kpi'
import { mergeWithDefaults } from '@/lib/reports/kpi-definitions'
import { parseDimensionFilterParams } from '@/lib/reports/dimension-filter'
import type { KPIReport, KPIPreferences } from '@/types'

export const GET = withRouteContext('report.kpi', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')
  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', periodId)
    .eq('company_id', companyId)
    .single()

  if (periodError || !period) {
    return NextResponse.json({ error: 'Fiscal period not found' }, { status: 404 })
  }

  // Dimension filter applies to the P&L-side KPIs only (net result, revenue/
  // expenses, months, expense composition). Balance-side KPIs (cash, VAT,
  // receivables) and supplier/invoice aggregates stay company-wide: a
  // dimension-scoped "cash position" would be silently wrong, not filtered.
  // The KPI view hides those tiles when a filter is active.
  const dimFilter = parseDimensionFilterParams(searchParams)
  if (!dimFilter.ok) {
    return NextResponse.json({ error: dimFilter.error }, { status: 400 })
  }
  const dimensions = dimFilter.dimensions

  // Load user preferences for account overrides
  const { data: prefsData } = await supabase
    .from('extension_data')
    .select('value')
    .eq('company_id', companyId)
    .eq('extension_id', 'core/kpi')
    .eq('key', 'preferences')
    .single()

  const preferences = mergeWithDefaults(
    (prefsData?.value as Partial<KPIPreferences>) ?? {}
  )

  const [
    incomeStatement,
    trialBalanceResult,
    arLedger,
    monthlyBreakdown,
    paidInvoicesResult,
    topSuppliersResult,
    filteredTrialBalance,
  ] = await Promise.all([
    generateIncomeStatement(supabase, companyId, periodId, { dimensions }),
    generateTrialBalance(supabase, companyId, periodId),
    generateARLedger(supabase, companyId),
    generateMonthlyBreakdown(supabase, companyId, periodId, { dimensions }),
    supabase
      .from('invoices')
      .select('invoice_date, paid_at')
      .eq('company_id', companyId)
      .eq('status', 'paid')
      .not('paid_at', 'is', null),
    supabase
      .from('supplier_invoices')
      .select('supplier_id, total_sek, total, supplier:suppliers(id, name)')
      .eq('company_id', companyId)
      .gte('invoice_date', period.period_start)
      .lte('invoice_date', period.period_end)
      .neq('status', 'credited'),
    // Second, dimension-scoped TB only when filtered: feeds the expense
    // composition (classes 4-7, P&L) without touching the unfiltered TB the
    // balance-side KPIs read.
    dimensions
      ? generateTrialBalance(supabase, companyId, periodId, { dimensions })
      : Promise.resolve(null),
  ])

  // Cash position: use account overrides if set
  const cashOverrides = preferences.accountOverrides['cashPosition']
  let cashPosition: number
  if (cashOverrides && cashOverrides.length > 0) {
    const cashRows = trialBalanceResult.rows.filter((r) =>
      cashOverrides.includes(r.account_number)
    )
    cashPosition = Math.round(
      cashRows.reduce((sum, r) => sum + (r.closing_debit - r.closing_credit), 0) * 100
    ) / 100
  } else {
    cashPosition = calculateCashPosition(trialBalanceResult.rows)
  }

  // VAT liability: use account overrides if set
  const vatLiability = calculateVatLiability(
    trialBalanceResult.rows,
    preferences.accountOverrides['vatLiability']
  )

  // Avg payment days from paid invoices
  const paidInvoices = (paidInvoicesResult.data ?? []).map((inv) => ({
    invoice_date: inv.invoice_date as string,
    paid_at: inv.paid_at as string,
  }))

  // Expense composition by BAS class (4-7). Expense accounts have a debit
  // normal balance, so amount = closing_debit - closing_credit. Negative
  // values (rare reclassifications) are clamped to 0 so the donut renders
  // sensibly.
  const expenseComposition = (filteredTrialBalance ?? trialBalanceResult).rows.reduce(
    (acc, r) => {
      if (r.account_class < 4 || r.account_class > 7) return acc
      const amount = r.closing_debit - r.closing_credit
      if (amount <= 0) return acc
      if (r.account_class === 4) acc.class4 += amount
      else if (r.account_class === 5) acc.class5 += amount
      else if (r.account_class === 6) acc.class6 += amount
      else if (r.account_class === 7) acc.class7 += amount
      return acc
    },
    { class4: 0, class5: 0, class6: 0, class7: 0 }
  )

  // Top suppliers by spend within the fiscal period. Sum total_sek to avoid
  // mixing currencies. Drop FX invoices without a SEK conversion (total_sek
  // null): they would otherwise inflate a supplier's total with raw
  // foreign-currency amounts.
  type SupplierInvoiceRow = {
    supplier_id: string | null
    total_sek: number | null
    total: number | null
    supplier: { id: string; name: string } | { id: string; name: string }[] | null
  }
  if (topSuppliersResult.error) {
    // Surface the failure rather than silently rendering an empty chart that
    // matches the legitimate "no supplier invoices" empty state.
    console.error('[kpi] topSuppliersResult error:', topSuppliersResult.error)
  }
  const supplierTotals = new Map<string, { name: string; total: number }>()
  for (const row of (topSuppliersResult.data ?? []) as SupplierInvoiceRow[]) {
    if (!row.supplier_id) continue
    const supplier = Array.isArray(row.supplier) ? row.supplier[0] : row.supplier
    if (!supplier?.name) continue
    const amount = row.total_sek ?? null
    if (amount == null) continue
    const existing = supplierTotals.get(row.supplier_id)
    if (existing) existing.total += amount
    else supplierTotals.set(row.supplier_id, { name: supplier.name, total: amount })
  }
  const topSuppliers = Array.from(supplierTotals.entries())
    .map(([supplier_id, v]) => ({
      supplier_id,
      supplier_name: v.name,
      total: Math.round(v.total * 100) / 100,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 7)

  const report: KPIReport = {
    netResult: incomeStatement.net_result,
    cashPosition,
    outstandingReceivables: arLedger.total_outstanding,
    overdueReceivables: arLedger.total_overdue,
    vatLiability,
    totalRevenue: incomeStatement.total_revenue,
    totalExpenses: incomeStatement.total_expenses,
    grossMargin: calculateGrossMargin(incomeStatement),
    expenseRatio: calculateExpenseRatio(incomeStatement),
    avgPaymentDays: calculateAvgPaymentDays(paidInvoices),
    periodComplete: period.is_closed,
    months: monthlyBreakdown.months,
    period: { start: period.period_start, end: period.period_end },
    expenseComposition: {
      class4: Math.round(expenseComposition.class4 * 100) / 100,
      class5: Math.round(expenseComposition.class5 * 100) / 100,
      class6: Math.round(expenseComposition.class6 * 100) / 100,
      class7: Math.round(expenseComposition.class7 * 100) / 100,
    },
    topSuppliers,
  }

  return NextResponse.json({ data: report })
})
