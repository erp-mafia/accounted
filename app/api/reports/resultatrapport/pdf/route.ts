import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { generateResultatrapport } from '@/lib/reports/resultatrapport'
import { ResultatrapportPDF } from '@/lib/reports/operational-report-pdf-template'
import { requireCompanyId } from '@/lib/company/context'
import { parseReportDateRange } from '@/lib/reports/date-range'
import type { CompanySettings } from '@/types'
import { parseDimensionFilterParams, dimensionFilterDisclosure, dimensionFilterFileSuffix } from '@/lib/reports/dimension-filter'

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

  const [{ data: period }, { data: companyRow }] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
      .eq('id', periodId)
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', companyId)
      .single(),
  ])

  if (!companyRow) {
    return NextResponse.json({ error: 'Företagsinställningar saknas' }, { status: 404 })
  }
  // An identifiable period is part of räkenskapsinformation (BFL 7 kap). Refuse
  // to render a PDF that can't be archived with the period it refers to.
  if (!period) {
    return NextResponse.json(
      { error: 'Räkenskapsperioden kunde inte läsas. Välj en befintlig period innan du genererar PDF.' },
      { status: 400 }
    )
  }

  const parsedRange = parseReportDateRange(searchParams, period)
  if (!parsedRange.ok) {
    return NextResponse.json({ error: parsedRange.error }, { status: 400 })
  }

  const dimFilter = parseDimensionFilterParams(searchParams)
  if (!dimFilter.ok) {
    return NextResponse.json({ error: dimFilter.error }, { status: 400 })
  }

  try {
    const report = await generateResultatrapport(supabase, companyId, periodId, {
      ...parsedRange.range,
      dimensions: dimFilter.dimensions,
    })

    const pdfBuffer = await renderToBuffer(
      ResultatrapportPDF({
        report,
        company: companyRow as CompanySettings,
        generatedAt: new Date().toISOString(),
        // Partial-view disclosure in the document header (BFNAR 2013:2).
        filterNote: dimensionFilterDisclosure(dimFilter.dimensions) ?? undefined,
      })
    )

    const filename = `resultatrapport${dimensionFilterFileSuffix(dimFilter.dimensions)}-${report.period.start}--${report.period.end}.pdf`

    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
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
