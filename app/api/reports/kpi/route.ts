import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import {
  generateIncomeStatement,
  buildIncomeStatementFromRows,
} from '@/lib/reports/income-statement'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateARLedger, type ARLedgerReport } from '@/lib/reports/ar-ledger'
import {
  generateMonthlyBreakdown,
  assembleMonthlyBreakdown,
  type MonthlyBreakdown,
} from '@/lib/reports/monthly-breakdown'
import {
  fetchKpiAggregates,
  buildOpeningBalances,
  buildTrialBalanceRows,
} from '@/lib/reports/kpi-aggregates'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  calculateCashPosition,
  calculateGrossMargin,
  calculateExpenseRatio,
  calculateAvgPaymentDays,
  calculateVatLiability,
  aggregateTopSuppliers,
  fetchTopSupplierInvoices,
  type KpiSupplierInvoiceRow,
} from '@/lib/reports/kpi'
import { mergeWithDefaults } from '@/lib/reports/kpi-definitions'
import { parseDimensionFilterParams } from '@/lib/reports/dimension-filter'
import type {
  KPIReport,
  KPIPreferences,
  IncomeStatementReport,
  TrialBalanceRow,
} from '@/types'

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

  // The company-wide queries both paths share. Factories, not promises, so
  // each Promise.all issues them inside its own single round-trip wave.
  const prefsQuery = () =>
    supabase
      .from('extension_data')
      .select('value')
      .eq('company_id', companyId)
      .eq('extension_id', 'core/kpi')
      .eq('key', 'preferences')
      .single()
  const paidInvoicesQuery = () =>
    supabase
      .from('invoices')
      .select('invoice_date, paid_at')
      .eq('company_id', companyId)
      .eq('status', 'paid')
      .not('paid_at', 'is', null)
  // Paginated: awaiting the bare query capped the rows at PostgREST's 1000
  // default and silently corrupted the supplier totals for large companies.
  const topSuppliersQuery = () =>
    fetchTopSupplierInvoices(supabase, companyId, period.period_start, period.period_end)

  let prefsValue: unknown
  let incomeStatement: IncomeStatementReport
  let trialBalanceResult: { rows: TrialBalanceRow[] }
  let arLedger: ARLedgerReport
  let monthlyBreakdown: MonthlyBreakdown
  let paidInvoicesResult: { data: Array<{ invoice_date: string; paid_at: string }> | null }
  let topSuppliersResult: { data: unknown[] | null; error: unknown }
  let filteredTrialBalance: { rows: TrialBalanceRow[] } | null

  if (dimensions) {
    // Dimension-filtered path: the legacy generators, unchanged. The second,
    // dimension-scoped TB feeds the expense composition (classes 4-7, P&L)
    // without touching the unfiltered TB the balance-side KPIs read.
    const [prefsRes, is, tb, ar, mb, paid, sup, filteredTb] = await Promise.all([
      prefsQuery(),
      generateIncomeStatement(supabase, companyId, periodId, { dimensions }),
      // 'include' keeps this fallback path agreeing with the RPC path below,
      // which reads agg.tb (equally unexcluded). The expense-composition KPI is
      // therefore blank for a closed year; changing it moves a displayed figure
      // for every company that ran bokslut, which is Stage 2 of #1051
      // (DECISIONS.md:632), so it is recorded as a follow-up rather than done here.
      generateTrialBalance(supabase, companyId, periodId, { closingEntry: 'include' }),
      generateARLedger(supabase, companyId),
      generateMonthlyBreakdown(supabase, companyId, periodId, { dimensions }),
      paidInvoicesQuery(),
      topSuppliersQuery(),
      generateTrialBalance(supabase, companyId, periodId, { closingEntry: 'include', dimensions }),
    ])
    prefsValue = prefsRes.data?.value
    incomeStatement = is
    trialBalanceResult = tb
    arLedger = ar
    monthlyBreakdown = mb
    paidInvoicesResult = paid
    topSuppliersResult = sup
    filteredTrialBalance = filteredTb
  } else {
    // Hot path (no dimension filter): one Promise.all round trip. The
    // get_kpi_report_aggregates RPC replaces three full journal-line scans
    // (unfiltered TB, income-statement TB, monthly breakdown) with a single
    // SQL pass; the pure builders below reproduce the legacy merge/rounding.
    const obEntryId: string | null = period.opening_balance_entry_id ?? null
    const [agg, priorResult, accounts, prefsRes, ar, paid, sup] = await Promise.all([
      fetchKpiAggregates(supabase, companyId, periodId, obEntryId),
      // Opening balances without an OB entry fall back to the server-side
      // prior-period aggregate, exactly like getOpeningBalances.
      obEntryId
        ? Promise.resolve(null)
        : supabase.rpc('compute_prior_opening_balances', {
            p_company_id: companyId,
            p_period_start: period.period_start,
          }),
      fetchAllRows<{
        account_number: string
        account_name: string
        account_class: number
      }>(({ from, to }) =>
        supabase
          .from('chart_of_accounts')
          .select('account_number, account_name, account_class')
          .eq('company_id', companyId)
          .order('account_number', { ascending: true })
          .range(from, to)
      ),
      prefsQuery(),
      generateARLedger(supabase, companyId),
      paidInvoicesQuery(),
      topSuppliersQuery(),
    ])

    if (priorResult?.error) {
      // Mirrors the fallback branch of lib/reports/opening-balances.ts.
      throw new Error(priorResult.error.message)
    }

    const accountMap = new Map<string, { name: string; class: number }>()
    for (const acc of accounts) {
      accountMap.set(acc.account_number, {
        name: acc.account_name,
        class: acc.account_class,
      })
    }

    const openingBalances = buildOpeningBalances(
      agg,
      obEntryId ? null : (priorResult?.data ?? [])
    )
    trialBalanceResult = { rows: buildTrialBalanceRows(openingBalances, agg.tb, accountMap) }
    const rowsExYearEnd = buildTrialBalanceRows(openingBalances, agg.tb_ex_year_end, accountMap)
    incomeStatement = buildIncomeStatementFromRows(rowsExYearEnd)
    monthlyBreakdown = assembleMonthlyBreakdown(
      period.period_start,
      period.period_end,
      agg.monthly.map((m) => ({
        year: m.year,
        month0: m.month - 1,
        income: m.income,
        expenses: m.expenses,
      }))
    )
    prefsValue = prefsRes.data?.value
    arLedger = ar
    paidInvoicesResult = paid
    topSuppliersResult = sup
    filteredTrialBalance = null
  }

  const preferences = mergeWithDefaults(
    (prefsValue as Partial<KPIPreferences>) ?? {}
  )

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

  // Top expense accounts (classes 4-7) for the period: the concept's
  // "Största kostnaderna" list. Same debit-normal reading as the class
  // composition above.
  const topExpenseAccounts = (filteredTrialBalance ?? trialBalanceResult).rows
    .filter((r) => r.account_class >= 4 && r.account_class <= 7)
    .map((r) => ({
      account_number: r.account_number,
      account_name: r.account_name,
      total: Math.round((r.closing_debit - r.closing_credit) * 100) / 100,
    }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)

  // Top suppliers by spend within the fiscal period, in SEK. The per-row SEK
  // resolution and the FX exclusion count both live in aggregateTopSuppliers,
  // which the xlsx export calls with the same query, so the two reports cannot
  // disagree about the same company.
  if (topSuppliersResult.error) {
    // Surface the failure rather than silently rendering an empty chart that
    // matches the legitimate "no supplier invoices" empty state.
    console.error('[kpi] topSuppliersResult error:', topSuppliersResult.error)
  }
  const { suppliers: topSuppliers, unconvertedFxCount: topSuppliersUnconvertedFxCount } =
    aggregateTopSuppliers((topSuppliersResult.data ?? []) as KpiSupplierInvoiceRow[])

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
    topExpenseAccounts,
    topSuppliers,
    topSuppliersUnconvertedFxCount,
  }

  return NextResponse.json({ data: report })
})
