import { withRouteContext } from '@/lib/api/with-route-context'
import { getArsredovisningPdfFile } from '@/lib/bokslut/arsredovisning/file-service'
import { sessionFailureResponse } from '@/lib/operations/session'

export const GET = withRouteContext(
  'period.arsredovisning_pdf',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    // Narrative edits come from arsredovisning_narratives, loaded inside the
    // report builder. The URL stays clean: no narrative text in query params,
    // access logs, or browser history. The same service serves the v1 download.
    const versionId = new URL(request.url).searchParams.get('version') || undefined
    const outcome = await getArsredovisningPdfFile(
      { supabase, companyId, userId: ctx.user.id, log },
      { fiscal_period_id: id, version_id: versionId },
      // requireCompleteLedger below already holds the SIE read lease for a live read.
      { leaseLiveRead: false },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return sessionFailureResponse({ ok: false, code: 'INTERNAL_ERROR' }, log, requestId)
    const file = outcome.data
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': `inline; filename="${file.filename}"`,
        // ÅR contains company financials + officer names: don't let any
        // intermediary cache the document.
        'Cache-Control': 'private, no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        ...(file.versionId ? { 'X-Annual-Report-Version': file.versionId } : {}),
      },
    })
  },
  // Frozen versions remain readable during recovery; live balances do not.
  { requireCompleteLedger: request => !new URL(request.url).searchParams.get('version') },
)
