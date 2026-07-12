import { NextResponse } from 'next/server'
import { generateBalansrapport } from '@/lib/reports/balansrapport'
import { withRouteContext } from '@/lib/api/with-route-context'
import { parseReportDateRange } from '@/lib/reports/date-range'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'

interface FlatRow {
  group: string
  account_number: string
  account_name: string
  ib: number
  period_change: number
  ub: number
}

export const GET = withRouteContext('report.balansrapport.xlsx', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  const [{ data: companyRow }, { data: period }] = await Promise.all([
    supabase
      .from('company_settings')
      .select('company_name')
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
      .eq('id', periodId)
      .eq('company_id', companyId)
      .single(),
  ])

  let range: { fromDate?: string; toDate?: string } = {}
  if (period) {
    const parsed = parseReportDateRange(searchParams, period)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }
    range = parsed.range
  }

  try {
    const report = await generateBalansrapport(supabase, companyId, periodId, range)

    const rows: FlatRow[] = []
    for (const g of report.groups) {
      for (const r of g.rows) {
        rows.push({
          group: g.class_label,
          account_number: r.account_number,
          account_name: r.account_name,
          ib: r.ib,
          period_change: r.period_change,
          ub: r.ub,
        })
      }
      rows.push({
        group: g.class_label,
        account_number: '',
        account_name: `Summa ${g.class_label}`,
        ib: g.subtotal_ib,
        period_change: Math.round((g.subtotal_ub - g.subtotal_ib) * 100) / 100,
        ub: g.subtotal_ub,
      })
    }
    rows.push({
      group: 'Beräknat resultat',
      account_number: '',
      account_name: 'Beräknat resultat',
      ib: 0,
      period_change: report.beraknat_resultat,
      ub: report.beraknat_resultat,
    })

    const buffer = reportToWorkbook<FlatRow>([
      {
        name: 'Balansrapport',
        columns: [
          textColumn('Grupp'),
          textColumn('Konto'),
          textColumn('Kontonamn'),
          currencyColumn('IB'),
          currencyColumn('Periodförändring'),
          currencyColumn('UB'),
        ],
        rows,
        mapRow: (r) => [
          r.group,
          r.account_number,
          r.account_name,
          r.ib,
          r.period_change,
          r.ub,
        ],
      },
    ])

    const filename = xlsxFilename(
      'balansrapport',
      companyRow?.company_name ?? '',
      report.period.end,
    )
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Kunde inte generera balansrapport' },
      { status: 500 }
    )
  }
})
