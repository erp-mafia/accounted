import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { getNarrative } from '@/lib/bokslut/arsredovisning/narrative-service'
import { NarrativeUpdateSchema } from '@/lib/bokslut/arsredovisning/workflow-schemas'
import { updateArsredovisningNarrative } from '@/lib/bokslut/arsredovisning/workflow-service'
import { sessionFailureResponse } from '@/lib/operations/session'

export const GET = withRouteContext(
  'period.arsredovisning_narrative_get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      // Mirror the POST handler's period-ownership pre-check so a valid
      // JWT for company A can't probe / enumerate company B's period IDs
      // through this endpoint.
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (!period) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      const data = await getNarrative(supabase, companyId, id)
      return NextResponse.json({ data })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
)

/**
 * Save narrative overrides. The rules (period ownership, the registrerad
 * freeze, clearing the narrative confirmation) live in workflow-service.ts,
 * shared with the v1 and MCP doors (operation arsredovisning.update-narrative).
 * Deliberately NOT gated on the bookkeeping period lock: the narrative is
 * årsredovisning document text, and the normal flow closes the period
 * BEFORE the årsredovisning is written.
 */
export const POST = withRouteContext(
  'period.arsredovisning_narrative_post',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, NarrativeUpdateSchema)
    if (!validation.success) return validation.response
    const outcome = await updateArsredovisningNarrative(
      { supabase, companyId, userId: user.id, log },
      id,
      validation.data,
      { dryRun: false },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
