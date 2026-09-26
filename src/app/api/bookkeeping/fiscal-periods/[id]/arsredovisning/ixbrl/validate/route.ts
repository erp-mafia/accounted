import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateArsredovisningIxbrl } from '@/lib/bokslut/arsredovisning/file-service'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * GET /api/bookkeeping/fiscal-periods/:id/arsredovisning/ixbrl/validate
 *
 * Layer-1 validation (local mirror of Bolagsverket kontrollera, GUIDE
 * Appendix E) + a generation dry-run so taxonomy-level problems (unknown
 * concept, context mismatch) surface as issues instead of a 500 in the
 * preview. Layer 3 (the real kontrollera call) lives in the bolagsverket
 * extension and runs in the Skicka in step. The same service serves the v1
 * route and gnubok_validate_arsredovisning_ixbrl (operation
 * arsredovisning.validate-ixbrl).
 */
export const GET = withRouteContext(
  'period.arsredovisning_ixbrl_validate',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const url = new URL(request.url)
    const versionId = url.searchParams.get('version') || undefined
    const utdelningRaw = url.searchParams.get('utdelning')
    const outcome = await validateArsredovisningIxbrl(
      { supabase, companyId, userId: ctx.user.id, log },
      { fiscal_period_id: id, version_id: versionId, proposed_dividend: utdelningRaw ? Number(utdelningRaw) : undefined },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
)
