import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { dimensionCrossMeasureNote, generateDimensionCross } from '@/lib/reports/dimension-cross'
import { dimensionCrossFailure, readDimensionCrossRequest } from '@/lib/reports/dimension-cross-request'
import { fileResponse } from '@/lib/api/file-response'
import type { CompanySettings } from '@/types'

export const GET = withRouteContext(
  'report.dimension_cross.pdf',
  async (request, ctx) => {
    const req = await readDimensionCrossRequest(request, ctx)
    if (!req.ok) return req.response
    const { data: companyRow } = await ctx.supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', ctx.companyId!)
      .single()
    if (!companyRow) {
      return NextResponse.json({ error: 'Företagsinställningar saknas' }, { status: 404 })
    }
    try {
      const report = await generateDimensionCross(ctx.supabase, ctx.companyId!, req.periodId, {
        ...req.axes,
        fromDate: req.range.fromDate,
        toDate: req.range.toDate,
      })
      const [{ renderToBuffer }, { DimensionCrossPDF }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('@/lib/reports/operational-report-pdf-template'),
      ])
      const pdf = await renderToBuffer(
        DimensionCrossPDF({
          report,
          company: companyRow as CompanySettings,
          generatedAt: new Date().toISOString(),
          measureNote: dimensionCrossMeasureNote(report),
        }),
      )
      const filename = `resultat-per-tva-dimensioner-${report.period.start}--${report.period.end}.pdf`
      return fileResponse(new Uint8Array(pdf), { filename, contentType: 'application/pdf' })
    } catch (err) {
      return dimensionCrossFailure(err, ctx, 'dimension cross pdf')
    }
  },
  { requireCompleteLedger: true },
)
