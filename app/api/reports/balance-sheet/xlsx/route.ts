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

interface FlatRow {
  section: string
  account_number: string
  account_name: string
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
    const assetRows: FlatRow[] = []
    for (const s of report.asset_sections) {
      for (const r of s.rows) {
        assetRows.push({
          section: s.title,
          account_number: r.account_number,
          account_name: r.account_name,
          amount: r.amount,
          isSubtotal: false,
        })
      }
      assetRows.push({
        section: s.title,
        account_number: '',
        account_name: `Summa ${s.title}`,
        amount: s.subtotal,
        isSubtotal: true,
      })
    }
    assetRows.push({
      section: 'Tillgångar',
      account_number: '',
      account_name: 'Summa tillgångar',
      amount: report.total_assets,
      isSubtotal: true,
    })

    const equityRows: FlatRow[] = []
    for (const s of report.equity_liability_sections) {
      for (const r of s.rows) {
        equityRows.push({
          section: s.title,
          account_number: r.account_number,
          account_name: r.account_name,
          amount: r.amount,
          isSubtotal: false,
        })
      }
      equityRows.push({
        section: s.title,
        account_number: '',
        account_name: `Summa ${s.title}`,
        amount: s.subtotal,
        isSubtotal: true,
      })
    }
    equityRows.push({
      section: 'Eget kapital och skulder',
      account_number: '',
      account_name: 'Summa eget kapital och skulder',
      amount: report.total_equity_liabilities,
      isSubtotal: true,
    })

    const buffer = reportToWorkbook<FlatRow>([
      {
        name: 'Tillgångar',
        columns: [
          textColumn('Sektion'),
          textColumn('Konto'),
          textColumn('Kontonamn'),
          currencyColumn('Belopp'),
        ],
        rows: assetRows,
        mapRow: (r) => [r.section, r.account_number, r.account_name, r.amount],
      },
      {
        name: 'Eget kapital och skulder',
        columns: [
          textColumn('Sektion'),
          textColumn('Konto'),
          textColumn('Kontonamn'),
          currencyColumn('Belopp'),
        ],
        rows: equityRows,
        mapRow: (r) => [r.section, r.account_number, r.account_name, r.amount],
      },
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
      { error: err instanceof Error ? err.message : 'Kunde inte generera balansräkning' },
      { status: 500 }
    )
  }
})
