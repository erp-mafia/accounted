import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { FinancialStatementPDF } from '@/lib/reports/financial-statement-pdf-template'
import { buildIncomeStatementPdfModel } from '@/lib/reports/financial-statement-pdf'
import { withRouteContext } from '@/lib/api/with-route-context'
import { parseReportDateRange } from '@/lib/reports/date-range'
import type { CompanySettings } from '@/types'
import { parseDimensionFilterParams, dimensionFilterDisclosure, dimensionFilterFileSuffix } from '@/lib/reports/dimension-filter'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

export const GET = withRouteContext('report.income_statement.pdf', async (request, { supabase, companyId }) => {
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
  const range = parsedRange.range
  const effectiveStart = range.fromDate ?? period.period_start
  const effectiveEnd = range.toDate ?? period.period_end

  const dimFilter = parseDimensionFilterParams(searchParams)
  if (!dimFilter.ok) {
    return NextResponse.json({ error: dimFilter.error }, { status: 400 })
  }

  try {
    const report = await generateIncomeStatement(supabase, companyId, periodId, {
      ...range,
      dimensions: dimFilter.dimensions,
    })
    report.period = { start: effectiveStart, end: effectiveEnd }

    const { groups, summary } = buildIncomeStatementPdfModel(report)

    const pdfBuffer = await renderToBuffer(
      FinancialStatementPDF({
        // Partial-view disclosure in the document title (BFNAR 2013:2).
        title: dimensionFilterDisclosure(dimFilter.dimensions)
          ? `Resultaträkning: ${dimensionFilterDisclosure(dimFilter.dimensions)}`
          : 'Resultaträkning',
        groups,
        summary,
        period: report.period,
        company: companyRow as CompanySettings,
        generatedAt: new Date().toISOString(),
      })
    )

    // "-utkast" suffix keeps the draft status visible even after the file
    // leaves the browser: complements the in-document ÅRL 2:7 disclaimer.
    const filename = `resultatrakning${dimensionFilterFileSuffix(dimFilter.dimensions)}-${report.period.start}--${report.period.end}-utkast.pdf`

    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte generera resultaträkning' },
      { status: 500 }
    )
  }
})
