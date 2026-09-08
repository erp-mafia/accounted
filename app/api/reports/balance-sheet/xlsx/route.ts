import { NextResponse } from 'next/server'
import { generateBalanceSheet } from '@/lib/reports/balance-sheet'
import { withRouteContext } from '@/lib/api/with-route-context'
import { parseReportDateRange } from '@/lib/reports/date-range'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type { BalanceSheetSection } from '@/types'

interface FlatRow {
  section: string
  account_number: string
  account_name: string
  year_ib: number
  ib: number
  period_change: number
  amount: number
  isSubtotal: boolean
}

export const GET = withRouteContext('report.balance_sheet.xlsx', async (request, { supabase, companyId }) => {
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

  try {
    const report = await generateBalanceSheet(supabase, companyId, periodId, range)

    // Flatten nested sections into a single tabular view, mirroring how the
    // PDF lays them out: each section's rows followed by a subtotal line, with
    // grand totals at the end. The "Sektion" column keeps the grouping queryable.
    const flattenSections = (
      sections: BalanceSheetSection[],
      groupLabel: string,
      groupTotalLabel: string,
      groupTotals: { year_ib: number; ib: number; period_change: number; amount: number },
    ): FlatRow[] => {
      const rows: FlatRow[] = []
      for (const s of sections) {
        for (const r of s.rows) {
          rows.push({
            section: s.title,
            account_number: r.account_number,
            account_name: r.account_name,
            year_ib: r.year_ib,
            ib: r.ib,
            period_change: r.period_change,
            amount: r.amount,
            isSubtotal: false,
          })
        }
        rows.push({
          section: s.title,
          account_number: '',
          account_name: `Summa ${s.title}`,
          year_ib: s.subtotal_year_ib,
          ib: s.subtotal_ib,
          period_change: s.subtotal_period_change,
          amount: s.subtotal,
          isSubtotal: true,
        })
      }
      rows.push({
        section: groupLabel,
        account_number: '',
        account_name: groupTotalLabel,
        ...groupTotals,
        isSubtotal: true,
      })
      return rows
    }

    const assetRows = flattenSections(
      report.asset_sections,
      'Tillgångar',
      'Summa tillgångar',
      {
        year_ib: report.total_assets_year_ib,
        ib: report.total_assets_ib,
        period_change: report.total_assets_period_change,
        amount: report.total_assets,
      },
    )

    const equityRows = flattenSections(
      report.equity_liability_sections,
      'Eget kapital och skulder',
      'Summa eget kapital och skulder',
      {
        year_ib: report.total_equity_liabilities_year_ib,
        ib: report.total_equity_liabilities_ib,
        period_change: report.total_equity_liabilities_period_change,
        amount: report.total_equity_liabilities,
      },
    )

    const columns = [
      textColumn('Sektion'),
      textColumn('Konto'),
      textColumn('Kontonamn'),
      currencyColumn('Ingående balans'),
      currencyColumn('Ingående saldo'),
      currencyColumn('Period'),
      currencyColumn('Utgående balans'),
    ]
    const mapRow = (r: FlatRow) => [
      r.section,
      r.account_number,
      r.account_name,
      r.year_ib,
      r.ib,
      r.period_change,
      r.amount,
    ]

    const buffer = reportToWorkbook<FlatRow>([
      { name: 'Tillgångar', columns, rows: assetRows, mapRow },
      { name: 'Eget kapital och skulder', columns, rows: equityRows, mapRow },
    ])

    const filename = xlsxFilename('balansrakning', companyRow?.company_name ?? '', effectiveEnd)
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte generera balansräkning' },
      { status: 500 }
    )
  }
})
