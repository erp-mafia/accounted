import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { shareClassesCreate } from '@/lib/operations/bolaget'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { createShareClass } from '@/lib/bolaget/share-register'

/** POST /api/bolaget/share-classes: add a share class (operation share-classes.create). */
export const POST = withRouteContext(
  'bolaget.share_class_create',
  async (request, ctx) => {
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const validation = await validateBody(request, shareClassesCreate.input)
    if (!validation.success) return validation.response
    const outcome = await createShareClass(operationContext(ctx), validation.data, { dryRun: false })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data, warnings: outcome.warnings ?? [] }, { status: 201 })
  },
  { requireAdmin: true },
)
