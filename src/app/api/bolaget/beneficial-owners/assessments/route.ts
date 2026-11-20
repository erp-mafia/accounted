import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { beneficialOwnersConfirm } from '@/lib/operations/bolaget'
import { sessionFailureResponse } from '@/lib/operations/session'
import { confirmBeneficialOwners } from '@/lib/bolaget/beneficial-owners'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'

/**
 * POST /api/bolaget/beneficial-owners/assessments: record the LRVH 2:1
 * assessment; a changed set adds the Bolagsverket filing deadline
 * (operation beneficial-owners.confirm).
 */
export const POST = withRouteContext(
  'bolaget.beneficial_owners_confirm',
  async (request, ctx) => {
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const validation = await validateBody(request, beneficialOwnersConfirm.input)
    if (!validation.success) return validation.response
    const outcome = await confirmBeneficialOwners(operationContext(ctx), validation.data, { dryRun: false })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireAdmin: true },
)
