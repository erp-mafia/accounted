import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { getInk3Underlag } from '@/lib/reports/filing-report-service'
import { sessionFailureResponse } from '@/lib/operations/session'
import { fileResponse } from '@/lib/api/file-response'

const QuerySchema = z.object({
  period_id: z.string().uuid(),
  format: z.enum(['json', 'pdf']).optional(),
})

/**
 * GET /api/reports/ink3?period_id=…[&format=pdf]
 *
 * The INK3 underlag for an ideell förening: JSON for the screen, or the PDF
 * to keep beside the e-tjänst. The same service answers v1 and MCP
 * (reports.ink3); nothing here files anything.
 */
export const GET = withRouteContext(
  'report.ink3',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const query = validateQuery(request, QuerySchema)
    if (!query.success) return query.response
    const { period_id: periodId, format = 'json' } = query.data

    const outcome = await getInk3Underlag({ supabase, companyId: companyId!, userId: user.id, log }, periodId)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })

    if (format === 'pdf') {
      const [{ renderToBuffer }, { Ink3UnderlagPDF }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('@/lib/reports/ink3/pdf-template'),
      ])
      const pdf = await renderToBuffer(
        Ink3UnderlagPDF({ underlag: outcome.data, generatedAt: new Date().toISOString() }),
      )
      const { start, end } = outcome.data.fiscalYear
      return fileResponse(new Uint8Array(pdf), {
        filename: `ink3-underlag-${start}--${end}.pdf`,
        contentType: 'application/pdf',
        headers: { 'X-Request-Id': requestId },
      })
    }

    return NextResponse.json({ data: outcome.data })
  },
  { requireCompleteLedger: (request) => new URL(request.url).searchParams.get('format') === 'pdf' },
)
