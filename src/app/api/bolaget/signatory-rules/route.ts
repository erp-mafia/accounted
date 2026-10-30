import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { signatoryRulesSet } from '@/lib/operations/bolaget'
import { sessionFailureResponse } from '@/lib/operations/session'
import { setSignatoryRule } from '@/lib/bolaget/roles'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'

/** POST /api/bolaget/signatory-rules: set the firmateckning from a date (operation signatory-rules.set). */
export const POST = withRouteContext(
  'bolaget.signatory_rule_set',
  async (request, ctx) => {
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const validation = await validateBody(request, signatoryRulesSet.input)
    if (!validation.success) return validation.response
    const input = validation.data
    const outcome = await setSignatoryRule(operationContext(ctx), { ...input, source: input.decision_id ? 'decision' : 'person' }, { dryRun: false })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireAdmin: true },
)
