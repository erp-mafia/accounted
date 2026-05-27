import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { generateBalansrapport } from '@/lib/reports/balansrapport'
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
  ib: number
  period_change: number
  ub: number
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
    const report = await generateBalansrapport(supabase, companyId, periodId)

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
}
