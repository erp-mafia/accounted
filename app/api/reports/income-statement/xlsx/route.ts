import { NextResponse } from 'next/server'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { withRouteContext } from '@/lib/api/with-route-context'
import { parseReportDateRange } from '@/lib/reports/date-range'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'
import type { IncomeStatementSection } from '@/types'
import { parseDimensionFilterParams, dimensionFilterDisclosure, dimensionFilterFileSuffix } from '@/lib/reports/dimension-filter'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { roundOre } from '@/lib/money'

interface FlatRow {
  section: string
  account_number: string
  account_name: string
  ytd_opening: number
  amount: number
  ytd_closing: number
}

function flatten(
  sections: IncomeStatementSection[],
  groupLabel: string,
  groupTotalLabel: string,
  groupTotals: { ytd_opening: number; amount: number; ytd_closing: number },
): FlatRow[] {
  const rows: FlatRow[] = []
  for (const s of sections) {
    for (const r of s.rows) {
      rows.push({
        section: s.title,
        account_number: r.account_number,
        account_name: r.account_name,
        ytd_opening: r.ytd_opening,
        amount: r.amount,
        ytd_closing: r.ytd_closing,
      })
    }
    rows.push({
      section: s.title,
      account_number: '',
      account_name: `Summa ${s.title}`,
      ytd_opening: s.subtotal_ytd_opening,
      amount: s.subtotal,
      ytd_closing: s.subtotal_ytd_closing,
    })
  }
  rows.push({
    section: groupLabel,
    account_number: '',
    account_name: groupTotalLabel,
    ...groupTotals,
  })
  return rows
}

export const GET = withRouteContext('report.income_statement.xlsx', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  const [{ data: period }, { data: companyRow }] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
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
    return NextResponse.json({ error: 'Räkenskapsperioden kunde inte läsas.' }, { status: 400 })
  }

  const parsedRange = parseReportDateRange(searchParams, period)
  if (!parsedRange.ok) {
    return NextResponse.json({ error: parsedRange.error }, { status: 400 })
  }
  const range = parsedRange.range
  const effectiveEnd = range.toDate ?? period.period_end

  const dimFilter = parseDimensionFilterParams(searchParams)
  if (!dimFilter.ok) {
    return NextResponse.json({ error: dimFilter.error }, { status: 400 })
  }

  try {
    const report = await generateIncomeStatement(supabase, companyId, periodId, {
      ...range,
      dimensions: dimFilter.dimensions,
    })

    const revenueRows = flatten(
      report.revenue_sections,
      'Rörelseintäkter',
      'Summa rörelseintäkter',
      {
        ytd_opening: report.total_revenue_ytd_opening,
        amount: report.total_revenue,
        ytd_closing: report.total_revenue_ytd_closing,
      },
    )
    const expenseRows = flatten(
      report.expense_sections,
      'Rörelsekostnader',
      'Summa rörelsekostnader',
      {
        ytd_opening: report.total_expenses_ytd_opening,
        amount: report.total_expenses,
        ytd_closing: report.total_expenses_ytd_closing,
      },
    )
    const financialRows = flatten(
      report.financial_sections,
      'Finansiella poster',
      'Summa finansiella poster',
      {
        ytd_opening: report.total_financial_ytd_opening,
        amount: report.total_financial,
        ytd_closing: report.total_financial_ytd_closing,
      },
    )

    const summaryRows: FlatRow[] = [
      {
        section: 'Sammanfattning',
        account_number: '',
        account_name: 'Rörelseresultat',
        ytd_opening: roundOre(
          report.total_revenue_ytd_opening - report.total_expenses_ytd_opening,
        ),
        amount: roundOre(report.total_revenue - report.total_expenses),
        ytd_closing: roundOre(
          report.total_revenue_ytd_closing - report.total_expenses_ytd_closing,
        ),
      },
      {
        section: 'Sammanfattning',
        account_number: '',
        account_name: 'Årets resultat',
        ytd_opening: report.net_result_ytd_opening,
        amount: report.net_result,
        ytd_closing: report.net_result_ytd_closing,
      },
    ]

    const columns = [
      textColumn('Sektion'),
      textColumn('Konto'),
      textColumn('Kontonamn'),
      currencyColumn('Ingående saldo'),
      currencyColumn('Period'),
      currencyColumn('Ackumulerat'),
    ]
    const mapRow = (r: FlatRow) => [
      r.section,
      r.account_number,
      r.account_name,
      r.ytd_opening,
      r.amount,
      r.ytd_closing,
    ]

    // Partial-view disclosure on every sheet: any tab opened alone must
    // still identify the export as filtered (BFNAR 2013:2).
    const disclosure = dimensionFilterDisclosure(dimFilter.dimensions)
    if (disclosure) {
      const note: FlatRow = {
        section: disclosure,
        account_number: '',
        account_name: '',
        ytd_opening: null as unknown as number,
        amount: null as unknown as number,
        ytd_closing: null as unknown as number,
      }
      for (const sheetRows of [revenueRows, expenseRows, financialRows, summaryRows]) {
        sheetRows.unshift(note)
      }
    }

    const buffer = reportToWorkbook<FlatRow>([
      { name: 'Intäkter', columns, rows: revenueRows, mapRow },
      { name: 'Kostnader', columns, rows: expenseRows, mapRow },
      { name: 'Finansiella poster', columns, rows: financialRows, mapRow },
      { name: 'Sammanfattning', columns, rows: summaryRows, mapRow },
    ])

    const filename = xlsxFilename(
      `resultatrakning${dimensionFilterFileSuffix(dimFilter.dimensions)}`,
      companyRow?.company_name ?? '',
      effectiveEnd,
    )
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte generera resultaträkning' },
      { status: 500 }
    )
  }
})
