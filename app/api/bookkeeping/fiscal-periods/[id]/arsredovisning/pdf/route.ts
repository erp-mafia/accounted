import { renderToBuffer } from '@react-pdf/renderer'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildArsredovisningData } from '@/lib/bokslut/arsredovisning/build-data'
import { ArsredovisningPDF } from '@/lib/bokslut/arsredovisning/arsredovisning-pdf'
import { ArsredovisningK3PDF } from '@/lib/bokslut/arsredovisning/arsredovisning-k3-pdf'

export const GET = withRouteContext(
  'period.arsredovisning_pdf',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      // Narrative edits come from arsredovisning_narratives now, loaded
      // inside buildArsredovisningData. The URL stays clean — no narrative
      // text in query params, access logs, or browser history.
      const data = await buildArsredovisningData(supabase, companyId, id)
      // Dispatch on the framework recorded in the data. K3 documents need
      // the additional kassaflöde + equity-changes pages + richer noter
      // that ArsredovisningK3PDF renders. K2 (the default) keeps the
      // existing template byte-for-byte unchanged.
      const PdfComponent =
        data.accounting_framework === 'k3'
          ? ArsredovisningK3PDF
          : ArsredovisningPDF
      const pdfBuffer = await renderToBuffer(PdfComponent({ data }))
      // "-utkast" suffix mirrors the existing PDF routes; the file becomes
      // "fastställd" only after the signature flow records all signatures.
      // Sanitize the dynamic segment so a stray quote / newline in the date
      // (defensive — unlikely to ever happen) can't break the header.
      const safePeriodEnd = data.fiscal_period.period_end.replace(/[^\w.-]/g, '_')
      const filename = `arsredovisning-${safePeriodEnd}-utkast.pdf`
      return new Response(new Uint8Array(pdfBuffer), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${filename}"`,
          // ÅR contains company financials + officer names — don't let any
          // intermediary cache the document.
          'Cache-Control': 'private, no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      return errorResponse(err, log, { requestId })
    }
  },
)
