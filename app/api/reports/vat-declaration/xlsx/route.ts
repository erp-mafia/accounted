import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import {
  calculateVatDeclaration,
  formatPeriodLabel,
} from '@/lib/reports/vat-declaration'
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
} from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

interface RutaRow {
  ruta: string
  label: string
  amount: number
}

export const GET = withRouteContext('report.vat_declaration.xlsx', async (request, { supabase, companyId }) => {
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

  const { data: companyRow } = await supabase
    .from('company_settings')
    .select('company_name')
    .eq('company_id', companyId)
    .single()

  try {
    const declaration = await calculateVatDeclaration(
      supabase, companyId, periodType, year, period,
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
      { error: err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte generera momsdeklaration' },
      { status: 500 }
    )
  }
}, { requireCompleteLedger: true })
