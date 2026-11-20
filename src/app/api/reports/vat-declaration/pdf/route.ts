import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import {
  calculateVatDeclaration,
  formatPeriodLabel,
} from '@/lib/reports/vat-declaration'
import { buildManualFilingRows } from '@/lib/reports/vat-manual-filing'
import type { VatPeriodType, CompanySettings } from '@/types'
import { fileResponse } from '@/lib/api/file-response'

/**
 * Momsdeklaration PDF for manual filing at skatteverket.se. The declaration is
 * computed purely from the bookkeeping (no Skatteverket connection needed);
 * this is a reading/record copy in hela kronor, not a file that is uploaded to
 * Skatteverket. See lib/reports/vat-declaration-pdf-template.tsx.
 */
export const GET = withRouteContext(
  'reports.vat-declaration.pdf',
  async (request, { supabase, companyId }) => {
    const { searchParams } = new URL(request.url)
    const periodType = searchParams.get('periodType') as VatPeriodType | null
    const yearStr = searchParams.get('year')
    const periodStr = searchParams.get('period')
    // Yearly = räkenskapsår (see the main vat-declaration route); ignored for
    // monthly/quarterly.
    const fiscalPeriodId = searchParams.get('fiscal_period_id') ?? undefined

    if (!periodType || !yearStr || !periodStr) {
      return NextResponse.json(
        { error: 'periodType, year, and period are required' },
        { status: 400 },
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
      .select('*')
      .eq('company_id', companyId)
      .single()

    if (!companyRow) {
      return NextResponse.json({ error: 'Företagsinställningar saknas' }, { status: 404 })
    }

    const declaration = await calculateVatDeclaration(
      supabase,
      companyId,
      periodType,
      year,
      period,
      { fiscalPeriodId },
    )

    const rows = buildManualFilingRows(declaration.rutor)

    const [{ renderToBuffer }, { VatDeclarationPDF }] = await Promise.all([
      import('@react-pdf/renderer'),
      import('@/lib/reports/vat-declaration-pdf-template'),
    ])
    const pdfBuffer = await renderToBuffer(
      VatDeclarationPDF({
        rows,
        period: declaration.period,
        periodLabel: formatPeriodLabel(periodType, year, period),
        company: companyRow as CompanySettings,
        generatedAt: new Date().toISOString(),
      }),
    )

    const filename = `momsdeklaration-${declaration.period.start}--${declaration.period.end}.pdf`
    return fileResponse(new Uint8Array(pdfBuffer), { filename: filename, contentType: 'application/pdf' })
  }, { requireCompleteLedger: true })
