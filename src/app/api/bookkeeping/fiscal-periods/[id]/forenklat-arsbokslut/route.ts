import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import {
  getForenklatArsbokslut,
  updateForenklatArsbokslutInputs,
} from '@/lib/bokslut/forenklat-arsbokslut/service'
import { ForenklatArsbokslutInputsUpdateSchema } from '@/lib/bokslut/forenklat-arsbokslut/schemas'

/**
 * The förenklat årsbokslut (BFNAR 2010:1) of a räkenskapsår: the statements,
 * checks and inputs. The same service answers v1 and MCP
 * (reports.forenklat-arsbokslut).
 */
export const GET = withRouteContext(
  'period.forenklat_arsbokslut_get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const outcome = await getForenklatArsbokslut({ supabase, companyId, userId: user.id, log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return sessionFailureResponse({ ok: false, code: 'INTERNAL_ERROR' }, log, requestId)
    return NextResponse.json({ data: outcome.data })
  },
  // The figures are live balances: never read them from a half-imported ledger.
  { requireCompleteLedger: true, uuidParams: { id: 'FISCAL_PERIOD_NOT_FOUND' } },
)

/**
 * Save the eligibility confirmation, the tilläggsupplysningar or the
 * signatories. The confirmation is recorded in the caller's name.
 */
export const PATCH = withRouteContext(
  'period.forenklat_arsbokslut_update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, ForenklatArsbokslutInputsUpdateSchema)
    if (!validation.success) return validation.response
    const outcome = await updateForenklatArsbokslutInputs(
      { supabase, companyId, userId: user.id, log },
      id,
      validation.data,
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return sessionFailureResponse({ ok: false, code: 'INTERNAL_ERROR' }, log, requestId)
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true, uuidParams: { id: 'FISCAL_PERIOD_NOT_FOUND' } },
)
