import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildIxbrlInput } from '@/lib/bokslut/ixbrl/build-input'
import { generateK2IxbrlDocument } from '@/lib/bokslut/ixbrl/document/k2-document'
import { getVersionIxbrlInput } from '@/lib/bokslut/arsredovisning/version-ixbrl'

/**
 * GET /api/bookkeeping/fiscal-periods/:id/arsredovisning/ixbrl
 *
 * Generates the iXBRL (XHTML) årsredovisning for the period. The document IS
 * the presentation (per TILLAMPNINGSANVISNING): the wizard renders it in an
 * iframe as the authoritative preview, and `?download=1` exports the same
 * bytes for validation and the company's archive. The XHTML file is not a
 * standalone manual filing path: digital filing goes through connected
 * software and the paper fallback is a certified copy sent by post.
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
    try {
      const url = new URL(request.url)
      const download = url.searchParams.get('download') === '1'
      const versionId = url.searchParams.get('version')
      const utdelningRaw = url.searchParams.get('utdelning')
      const proposedDividend = utdelningRaw ? Number(utdelningRaw) : undefined

      const input = versionId
        ? await getVersionIxbrlInput(supabase, companyId, id, versionId)
        : await buildIxbrlInput(supabase, companyId, id, {
            proposedDividend:
              proposedDividend !== undefined && Number.isFinite(proposedDividend)
                ? proposedDividend
                : undefined,
          })
      if (!input) return errorResponseFromCode('NOT_FOUND', log, { requestId })
      const { xhtml, warnings } = generateK2IxbrlDocument(input)

      const safePeriodEnd = input.period.end.replace(/[^\w.-]/g, '_')
      const filename = `arsredovisning-${safePeriodEnd}.xhtml`
      return new Response(xhtml, {
        headers: {
          // Served as XHTML so iframe preview renders the inline XBRL
          // document exactly as Bolagsverket will present it.
          'Content-Type': 'application/xhtml+xml; charset=utf-8',
          'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
          'Cache-Control': 'private, no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
          // Generation warnings surfaced without disturbing the body.
          'X-Ixbrl-Warning-Count': String(warnings.length),
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
  // The inline preview contains the same financial document as the download.
  { requireCompleteLedger: request => !new URL(request.url).searchParams.get('version') },
)
