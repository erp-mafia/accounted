import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { shareRegisterEventsCreate } from '@/lib/operations/bolaget'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { registerShareEvent } from '@/lib/bolaget/share-register'

/**
 * POST /api/bolaget/share-register/events: add an aktiebok entry
 * (?dry_run=true previews the holdings before and after). The same rules as
 * operation share-register.events.create.
 */
export const POST = withRouteContext(
  'bolaget.share_register_event_create',
  async (request, ctx) => {
    const gate = await bolagetGateResponse(ctx, 'registers')
    if (gate) return gate
    const validation = await validateBody(request, shareRegisterEventsCreate.input)
    if (!validation.success) return validation.response
    const dryRun = new URL(request.url).searchParams.get('dry_run') === 'true'
    const outcome = await registerShareEvent(operationContext(ctx), { ...validation.data, created_via: 'app' }, { dryRun })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data, warnings: outcome.warnings ?? [] }, { status: 201 })
  },
  { requireAdmin: true },
)
