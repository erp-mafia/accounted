import { withRouteContext } from '@/lib/api/with-route-context'
import { getArsredovisningIxbrlFile } from '@/lib/bokslut/arsredovisning/file-service'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * GET /api/bookkeeping/fiscal-periods/:id/arsredovisning/ixbrl
 *
 * Generates the iXBRL (XHTML) årsredovisning for the period. The document IS
 * the presentation (per TILLAMPNINGSANVISNING): the wizard renders it in an
 * iframe as the authoritative preview, and `?download=1` exports the same
 * bytes for validation and the company's archive. The XHTML file is not a
 * standalone manual filing path: digital filing goes through connected
 * software and the paper fallback is a certified copy sent by post. The same
 * service (file-service.ts) serves the v1 download.
 *
 * Query params:
 *   - download=1   → Content-Disposition: attachment
 *   - utdelning=N  → proposed dividend in whole SEK for the resultatdisposition
 */
export const GET = withRouteContext(
  'period.arsredovisning_ixbrl',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const url = new URL(request.url)
    const download = url.searchParams.get('download') === '1'
    const versionId = url.searchParams.get('version') || undefined
    const utdelningRaw = url.searchParams.get('utdelning')
    const outcome = await getArsredovisningIxbrlFile(
      { supabase, companyId, userId: ctx.user.id, log },
      { fiscal_period_id: id, version_id: versionId, proposed_dividend: utdelningRaw ? Number(utdelningRaw) : undefined },
      // requireCompleteLedger below already holds the SIE read lease for a live read.
      { leaseLiveRead: false },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return sessionFailureResponse({ ok: false, code: 'INTERNAL_ERROR' }, log, requestId)
    const file = outcome.data
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        // Served as XHTML so iframe preview renders the inline XBRL
        // document exactly as Bolagsverket will present it.
        'Content-Type': file.contentType,
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${file.filename}"`,
        'Cache-Control': 'private, no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        // Generation warnings surfaced without disturbing the body.
        'X-Ixbrl-Warning-Count': String(file.warningCount ?? 0),
        ...(file.versionId ? { 'X-Annual-Report-Version': file.versionId } : {}),
      },
    })
  },
  // The inline preview contains the same financial document as the download.
  { requireCompleteLedger: request => !new URL(request.url).searchParams.get('version') },
)
