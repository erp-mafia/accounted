import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { generateResultatrapport } from '@/lib/reports/resultatrapport'
import { parseReportDateRange } from '@/lib/reports/date-range'
import type { CompanySettings } from '@/types'
import { parseDimensionFilterParams, dimensionFilterDisclosure, dimensionFilterFileSuffix } from '@/lib/reports/dimension-filter'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { fileResponse } from '@/lib/api/file-response'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { budgetDisclosure, parseBudgetParam, ReportBudgetError } from '@/lib/budgets/report-budget'

export const GET = withRouteContext('report.resultatrapport.pdf', async (request, { supabase, companyId, log, requestId }) => {
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

  const budgetParam = parseBudgetParam(searchParams)
  if (!budgetParam.ok) {
    return NextResponse.json({ error: budgetParam.error }, { status: 400 })
  }

  try {
    const report = await generateResultatrapport(supabase, companyId, periodId, {
      ...parsedRange.range,
      dimensions: dimFilter.dimensions,
      budgetId: budgetParam.budgetId,
    })

    const [{ renderToBuffer }, { ResultatrapportPDF }] = await Promise.all([
      import('@react-pdf/renderer'),
      import('@/lib/reports/operational-report-pdf-template'),
    ])
    const pdfBuffer = await renderToBuffer(
      ResultatrapportPDF({
        report,
        company: companyRow as CompanySettings,
        generatedAt: new Date().toISOString(),
        // Partial-view disclosure in the document header (BFNAR 2013:2).
        filterNote: dimensionFilterDisclosure(dimFilter.dimensions) ?? undefined,
        budgetNote: budgetDisclosure(report.budget) ?? undefined,
      })
    )

    const filename = `resultatrapport${dimensionFilterFileSuffix(dimFilter.dimensions)}-${report.period.start}--${report.period.end}.pdf`

    return fileResponse(new Uint8Array(pdfBuffer), { filename: filename, contentType: 'application/pdf' })
  } catch (err) {
    if (err instanceof ReportBudgetError) return errorResponseFromCode(err.code, log, { requestId })
    return NextResponse.json(
      { error: err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte generera resultatrapport' },
      { status: 500 }
    )
  }
}, { requireCompleteLedger: true })
