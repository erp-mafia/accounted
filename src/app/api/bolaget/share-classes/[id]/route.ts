import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { ShareClassUpdateIn } from '@/lib/operations/bolaget'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { updateShareClass } from '@/lib/bolaget/share-register'

const PatchSchema = ShareClassUpdateIn.omit({ share_class_id: true })

/** PATCH /api/bolaget/share-classes/{id}: change a class's name, votes or förbehåll (operation share-classes.update). */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bolaget.share_class_update',
  async (request, ctx, { params }) => {
    const { id } = await params
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const validation = await validateBody(request, PatchSchema)
    if (!validation.success) return validation.response
    const outcome = await updateShareClass(operationContext(ctx), id, validation.data, { dryRun: false })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data, warnings: outcome.warnings ?? [] })
  },
  { requireWrite: true },
)
