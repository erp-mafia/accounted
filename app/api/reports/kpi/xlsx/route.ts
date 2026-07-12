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
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  percentColumn,
  integerColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'

interface KpiKv {
  label: string
  value: number | null
}

interface MonthRow {
  label: string
  income: number
  expenses: number
  net: number
}

interface CompositionRow {
  klass: string
  amount: number
}

interface SupplierRow {
  supplier_name: string
  total: number
}

export const GET = withRouteContext('report.kpi.xlsx', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')
  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  const [{ data: period }, { data: companyRow }] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('period_start, period_end, is_closed')
      .eq('id', periodId)
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('company_settings')
      .select('company_name')
      .eq('company_id', companyId)
      .single(),
  ])

  if (!period) {
    return NextResponse.json({ error: 'Fiscal period not found' }, { status: 404 })
  }

  try {
    const [
      incomeStatement,
      trialBalanceResult,
      arLedger,
      monthlyBreakdown,
      paidInvoicesResult,
      topSuppliersResult,
    ] = await Promise.all([
      generateIncomeStatement(supabase, companyId, periodId),
      generateTrialBalance(supabase, companyId, periodId),
      generateARLedger(supabase, companyId),
      generateMonthlyBreakdown(supabase, companyId, periodId),
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
    ])

    const cashPosition = calculateCashPosition(trialBalanceResult.rows)
    const vatLiability = calculateVatLiability(trialBalanceResult.rows)

    const paidInvoices = (paidInvoicesResult.data ?? []).map((inv) => ({
      invoice_date: inv.invoice_date as string,
      paid_at: inv.paid_at as string,
    }))

    // Expense composition by BAS class (mirrors KPI JSON route logic).
    const expenseComposition = trialBalanceResult.rows.reduce(
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
      { class4: 0, class5: 0, class6: 0, class7: 0 },
    )

    type SupplierInvoiceRow = {
      supplier_id: string | null
      total_sek: number | null
      total: number | null
      supplier: { id: string; name: string } | { id: string; name: string }[] | null
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
    const topSuppliers = Array.from(supplierTotals.values())
      .map((v) => ({
        supplier_name: v.name,
        total: Math.round(v.total * 100) / 100,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 7)

    // Sheet 1: scalar KPIs, label + value. Currency by default; percent rows
    // are split into a separate sheet so the formatting is unambiguous.
    const currencyKpis: KpiKv[] = [
      { label: 'Årets resultat', value: incomeStatement.net_result },
      { label: 'Likvida medel', value: cashPosition },
      { label: 'Utestående kundfordringar', value: arLedger.total_outstanding },
      { label: 'Förfallna kundfordringar', value: arLedger.total_overdue },
      { label: 'Momsskuld (ruta 49)', value: vatLiability },
      { label: 'Totala intäkter', value: incomeStatement.total_revenue },
      { label: 'Totala kostnader', value: incomeStatement.total_expenses },
    ]

    const percentKpis: KpiKv[] = [
      // calculateGrossMargin returns percentage as `25.5` (i.e. percent units).
      // The xlsx percent format expects fractional values (0.255 → 25.50%).
      // Divide by 100 so the displayed value matches the in-app KPI tile.
      { label: 'Bruttomarginal', value: scaleToFraction(calculateGrossMargin(incomeStatement)) },
      { label: 'Kostnadsandel', value: scaleToFraction(calculateExpenseRatio(incomeStatement)) },
    ]

    const integerKpis: KpiKv[] = [
      { label: 'Genomsnittliga betaldagar', value: calculateAvgPaymentDays(paidInvoices) },
    ]

    const monthRows: MonthRow[] = monthlyBreakdown.months

    const compositionRows: CompositionRow[] = [
      { klass: '4: Material/varor', amount: Math.round(expenseComposition.class4 * 100) / 100 },
      { klass: '5: Externa kostnader', amount: Math.round(expenseComposition.class5 * 100) / 100 },
      { klass: '6: Externa kostnader', amount: Math.round(expenseComposition.class6 * 100) / 100 },
      { klass: '7: Personalkostnader', amount: Math.round(expenseComposition.class7 * 100) / 100 },
    ]

    const supplierRows: SupplierRow[] = topSuppliers

    const buffer = reportToWorkbook([
      {
        name: 'Nyckeltal (kr)',
        columns: [textColumn('Nyckeltal'), currencyColumn('Värde')],
        rows: currencyKpis,
        mapRow: (r) => [r.label, r.value],
      },
      {
        name: 'Nyckeltal (%)',
        columns: [textColumn('Nyckeltal'), percentColumn('Värde')],
        rows: percentKpis,
        mapRow: (r) => [r.label, r.value],
      },
      {
        name: 'Nyckeltal (övrigt)',
        columns: [textColumn('Nyckeltal'), integerColumn('Värde')],
        rows: integerKpis,
        mapRow: (r) => [r.label, r.value],
      },
      {
        name: 'Månadsbrytning',
        columns: [
          textColumn('Månad'),
          currencyColumn('Intäkter'),
          currencyColumn('Kostnader'),
          currencyColumn('Netto'),
        ],
        rows: monthRows,
        mapRow: (m) => [m.label, m.income, m.expenses, m.net],
      },
      {
        name: 'Kostnadssammansättning',
        columns: [textColumn('Kontoklass'), currencyColumn('Belopp')],
        rows: compositionRows,
        mapRow: (r) => [r.klass, r.amount],
      },
      {
        name: 'Topp leverantörer',
        columns: [textColumn('Leverantör'), currencyColumn('Totalt')],
        rows: supplierRows,
        mapRow: (r) => [r.supplier_name, r.total],
      },
    ])

    const filename = xlsxFilename('nyckeltal', companyRow?.company_name ?? '', period.period_end)
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Kunde inte generera nyckeltalsrapport' },
      { status: 500 }
    )
  }
})

function scaleToFraction(value: number | null): number | null {
  return value === null ? null : Math.round(value) / 100
}
