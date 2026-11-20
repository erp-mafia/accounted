import { withRouteContext } from '@/lib/api/with-route-context'
import { fileResponse } from '@/lib/api/file-response'
import { sessionFailureResponse } from '@/lib/operations/session'
import { getForenklatArsbokslutPdfFile } from '@/lib/bokslut/forenklat-arsbokslut/service'

/**
 * The förenklat årsbokslut as the PDF the styrelse signs; refused with the
 * reasons while the report has blockers. The same service serves the v1
 * download (GET /api/v1/companies/{id}/reports/forenklat-arsbokslut/pdf).
 */
export const GET = withRouteContext(
  'period.forenklat_arsbokslut_pdf',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const outcome = await getForenklatArsbokslutPdfFile({ supabase, companyId, userId: user.id, log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return sessionFailureResponse({ ok: false, code: 'INTERNAL_ERROR' }, log, requestId)
    const file = outcome.data
    return fileResponse(new Uint8Array(file.bytes), {
      filename: file.filename,
      contentType: file.contentType,
      disposition: 'inline',
      // The förening's figures and its board members' names: no intermediary caches it.
      cacheControl: 'private, no-store, no-cache, must-revalidate',
      headers: { Pragma: 'no-cache' },
    })
  },
  { requireCompleteLedger: true },
)
