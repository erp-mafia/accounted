import { renderToBuffer } from '@react-pdf/renderer'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildCanonicalAnnualReport } from '@/lib/bokslut/arsredovisning/model'
import { getAnnualReportVersion } from '@/lib/bokslut/arsredovisning/version-service'
import { ArsredovisningPDF } from '@/lib/bokslut/arsredovisning/arsredovisning-pdf'
import { ArsredovisningK3PDF } from '@/lib/bokslut/arsredovisning/arsredovisning-k3-pdf'
import type { ArsredovisningData } from '@/lib/bokslut/arsredovisning/types'

export const GET = withRouteContext(
  'period.arsredovisning_pdf',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      // Narrative edits come from arsredovisning_narratives now, loaded
      // inside buildArsredovisningData. The URL stays clean, no narrative
      // text in query params, access logs, or browser history.
      const versionId = new URL(request.url).searchParams.get('version')
      let versionStatus: string | null = null
      let data: ArsredovisningData
      if (versionId) {
        const version = await getAnnualReportVersion(supabase, companyId, id, versionId)
        if (!version) {
          return errorResponseFromCode('NOT_FOUND', log, { requestId })
        }
        versionStatus = version.summary.status
        data = structuredClone(version.report_data)
        const { data: signatureRows, error: signatureError } = await supabase
          .from('arsredovisning_signature_requests')
          .select('role, signer_name, signed_at')
          .eq('company_id', companyId)
          .eq('fiscal_period_id', id)
          .eq('annual_report_version_id', versionId)
          .order('created_at', { ascending: true })
        if (signatureError) {
          throw new Error(`Failed to load version signatures: ${signatureError.message}`)
        }
        data.signatures = (signatureRows ?? []).map((signature) => ({
          role: signature.role,
          name: signature.signer_name,
          signed_at: signature.signed_at,
        }))
      } else {
        const model = await buildCanonicalAnnualReport(supabase, companyId, id, {
          stage: 'draft',
          includeIxbrl: false,
        })
        data = model.report
      }
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
      // (defensive, unlikely to ever happen) can't break the header.
      const safePeriodEnd = data.fiscal_period.period_end.replace(/[^\w.-]/g, '_')
      const suffix = versionStatus && ['signed', 'filed', 'registered'].includes(versionStatus)
        ? 'papperskopia'
        : 'utkast'
      const filename = `arsredovisning-${safePeriodEnd}-${suffix}.pdf`
      return new Response(new Uint8Array(pdfBuffer), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${filename}"`,
          // ÅR contains company financials + officer names: don't let any
          // intermediary cache the document.
          'Cache-Control': 'private, no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
          ...(versionId ? { 'X-Annual-Report-Version': versionId } : {}),
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
  // Frozen versions remain readable during recovery; live balances do not.
  { requireCompleteLedger: request => !new URL(request.url).searchParams.get('version') },
)
