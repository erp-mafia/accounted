import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { completeShareRegisterSetup } from '@/lib/bolaget/share-register'

const SetupSchema = z.object({ expected_last_event_number: z.number().int().min(0).nullish() }).strict()

/**
 * POST /api/bolaget/share-register/setup: say that every share of the
 * company is entered, which takes the aktiebok into use (?dry_run=true
 * answers what the register holds and what the step means, and saves
 * nothing). From then on an entry carries the day it is made and no opening
 * holding is taken; the completion is entered in the register as a dated
 * note. Done once.
 */
export const POST = withRouteContext(
  'bolaget.share_register_setup_complete',
  async (request, ctx) => {
    const gate = await bolagetGateResponse(ctx, 'registers')
    if (gate) return gate
    const validation = await validateBody(request, SetupSchema)
    if (!validation.success) return validation.response
    const dryRun = new URL(request.url).searchParams.get('dry_run') === 'true'
    const outcome = await completeShareRegisterSetup(operationContext(ctx), validation.data, { dryRun })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireAdmin: true },
)
