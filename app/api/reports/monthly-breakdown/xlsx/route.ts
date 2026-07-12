import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { generateMonthlyBreakdown } from '@/lib/reports/monthly-breakdown'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'

export const GET = withRouteContext('report.monthly_breakdown.xlsx', async (request, { supabase, companyId }) => {
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

  try {
    const breakdown = await generateMonthlyBreakdown(supabase, companyId, periodId)

    const buffer = reportToWorkbook([
      {
        name: 'Månadsbrytning',
        columns: [
          textColumn('Månad'),
          currencyColumn('Intäkter'),
          currencyColumn('Kostnader'),
          currencyColumn('Netto'),
        ],
        rows: breakdown.months,
        mapRow: (m) => [m.label, m.income, m.expenses, m.net],
      },
    ])

    const filename = xlsxFilename(
      'manadsbrytning',
      companyRow?.company_name ?? '',
      period?.period_end ?? new Date().toISOString().slice(0, 10),
    )
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Kunde inte generera månadsbrytning' },
      { status: 500 }
    )
  }
})
