import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { saveK10Inputs } from '@/lib/bolaget/owner-tax/k10'
import { K10InputsBody } from '@/lib/bolaget/owner-tax/schemas'
import { isUuid } from '@/lib/invariants/uuid'
import { parseIncomeYear } from '../../../../year'

/**
 * PUT /api/bolaget/owner-tax/k10/{year}/owners/{partyId}: save what a
 * delägare enters for the K10 underlag of a year (?dry_run=true previews).
 * The same rules as operation k10-inputs.set.
 */
export const PUT = withRouteContext<{ params: Promise<{ year: string; partyId: string }> }>(
  'bolaget.k10_inputs_set',
  async (request, ctx, { params }) => {
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const { year: rawYear, partyId } = await params
    const year = parseIncomeYear(rawYear)
    if (year === null || !isUuid(partyId)) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const validation = await validateBody(request, K10InputsBody)
    if (!validation.success) return validation.response
    const dryRun = new URL(request.url).searchParams.get('dry_run') === 'true'
    const outcome = await saveK10Inputs(operationContext(ctx), { ...validation.data, party_id: partyId, income_year: year }, { dryRun })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
