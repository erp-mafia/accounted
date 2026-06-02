import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import {
  calculateVatDeclaration,
  formatPeriodLabel,
} from '@/lib/reports/vat-declaration'
import { requireCompanyId } from '@/lib/company/context'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'
import {
  VAT_RUTA_LABELS,
  type VatPeriodType,
  type VatDeclarationRutor,
  type AccountingMethod,
} from '@/types'

interface RutaRow {
  ruta: string
  label: string
  amount: number
}

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { searchParams } = new URL(request.url)
  const periodType = searchParams.get('periodType') as VatPeriodType | null
  const yearStr = searchParams.get('year')
  const periodStr = searchParams.get('period')
  // Yearly = räkenskapsår (see main route); ignored for monthly/quarterly.
  const fiscalPeriodId = searchParams.get('fiscal_period_id') ?? undefined

  if (!periodType || !yearStr || !periodStr) {
    return NextResponse.json(
      { error: 'periodType, year, and period are required' },
      { status: 400 }
    )
  }
  if (!['monthly', 'quarterly', 'yearly'].includes(periodType)) {
    return NextResponse.json({ error: 'Invalid periodType' }, { status: 400 })
  }

  const year = parseInt(yearStr, 10)
  const period = parseInt(periodStr, 10)
  if (isNaN(year) || isNaN(period)) {
    return NextResponse.json({ error: 'Invalid year or period' }, { status: 400 })
  }

  const [{ data: settings }, { data: companyRow }] = await Promise.all([
    supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('company_settings')
      .select('company_name')
      .eq('company_id', companyId)
      .single(),
  ])

  const accountingMethod = (settings?.accounting_method as AccountingMethod) || 'accrual'

  try {
    const declaration = await calculateVatDeclaration(
      supabase, companyId, periodType, year, period, accountingMethod,
      { fiscalPeriodId },
    )

    const rows: RutaRow[] = (Object.keys(declaration.rutor) as (keyof VatDeclarationRutor)[]).map(
      (key) => ({
        ruta: key.replace(/^ruta/, 'Ruta '),
        label: VAT_RUTA_LABELS[key],
        amount: declaration.rutor[key],
      }),
    )

    const buffer = reportToWorkbook<RutaRow>([
      {
        name: `Moms ${formatPeriodLabel(periodType, year, period)}`,
        columns: [
          textColumn('Ruta'),
          textColumn('Beskrivning'),
          currencyColumn('Belopp'),
        ],
        rows,
        mapRow: (r) => [r.ruta, r.label, r.amount],
      },
    ])

    const filename = xlsxFilename(
      'momsdeklaration',
      companyRow?.company_name ?? '',
      declaration.period.end,
    )
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Kunde inte generera momsdeklaration' },
      { status: 500 }
    )
  }
}
