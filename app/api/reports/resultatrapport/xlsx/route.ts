import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { generateResultatrapport } from '@/lib/reports/resultatrapport'
import { requireCompanyId } from '@/lib/company/context'
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

  const { data: companyRow } = await supabase
    .from('company_settings')
    .select('company_name')
    .eq('company_id', companyId)
    .single()

  try {
    const report = await generateResultatrapport(supabase, companyId, periodId)

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
      'resultatrapport',
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
