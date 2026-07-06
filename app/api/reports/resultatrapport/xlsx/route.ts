import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { generateResultatrapport } from '@/lib/reports/resultatrapport'
import { requireCompanyId } from '@/lib/company/context'
import { parseReportDateRange } from '@/lib/reports/date-range'
import { parseDimensionFilterParams, dimensionFilterDisclosure, dimensionFilterFileSuffix } from '@/lib/reports/dimension-filter'
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
  current_period: number
  prior_period: number
}

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

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

  const dimFilter = parseDimensionFilterParams(searchParams)
  if (!dimFilter.ok) {
    return NextResponse.json({ error: dimFilter.error }, { status: 400 })
  }

  try {
    const report = await generateResultatrapport(supabase, companyId, periodId, {
      ...range,
      dimensions: dimFilter.dimensions,
    })

    const rows: FlatRow[] = []
    for (const g of report.groups) {
      for (const r of g.rows) {
        rows.push({
          group: g.class_label,
          account_number: r.account_number,
          account_name: r.account_name,
          current_period: r.current_period,
          prior_period: r.prior_period,
        })
      }
      rows.push({
        group: g.class_label,
        account_number: '',
        account_name: `Summa ${g.class_label}`,
        current_period: g.subtotal_current,
        prior_period: g.subtotal_prior,
      })
    }
    rows.push({
      group: 'Resultat',
      account_number: '',
      account_name: 'Årets resultat',
      current_period: report.net_result_current,
      prior_period: report.net_result_prior,
    })

    // Partial-view disclosure survives the file boundary: a filtered export
    // must never be mistakable for the authoritative report (BFNAR 2013:2).
    const disclosure = dimensionFilterDisclosure(dimFilter.dimensions)
    if (disclosure) {
      rows.unshift({
        group: disclosure,
        account_number: '',
        account_name: '',
        current_period: null as unknown as number,
        prior_period: null as unknown as number,
      })
    }

    const buffer = reportToWorkbook<FlatRow>([
      {
        name: 'Resultatrapport',
        columns: [
          textColumn('Grupp'),
          textColumn('Konto'),
          textColumn('Kontonamn'),
          currencyColumn('Aktuell period'),
          currencyColumn('Föregående period'),
        ],
        rows,
        mapRow: (r) => [
          r.group,
          r.account_number,
          r.account_name,
          r.current_period,
          r.prior_period,
        ],
      },
    ])

    const filename = xlsxFilename(
      `resultatrapport${dimensionFilterFileSuffix(dimFilter.dimensions)}`,
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
      { error: err instanceof Error ? err.message : 'Kunde inte generera resultatrapport' },
      { status: 500 }
    )
  }
}
