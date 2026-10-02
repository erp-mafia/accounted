/**
 * PATCH /api/dimensions/[id]: update a dimension (name / is_active / sort_order).
 * DELETE /api/dimensions/[id]: remove a custom dimension nobody has booked on.
 *
 * Guard rails:
 *   - Renaming an is_system dimension (1 = Kostnadsställe, 6 = Projekt) is
 *     rejected with 400 DIMENSION_SYSTEM_RENAME ("Systemdimensioner kan inte
 *     döpas om"). Archiving (is_active=false) and reordering remain allowed.
 *   - sie_dim_no / is_system are immutable at the DB level
 *     (enforce_dimension_registry_guards) and not accepted here at all.
 *   - DELETE (issue #2219): a system dimension answers 400
 *     DIMENSION_SYSTEM_DELETE before the DB is asked. A custom dimension whose
 *     number is tagged on any posted/reversed line is refused by the same DB
 *     guard with a P0001 that names the dimension; that message rides the 409
 *     DIMENSION_REFERENCED envelope verbatim. Values cascade (ON DELETE
 *     CASCADE) and the value retention trigger fires on the cascade too, so
 *     nothing booked can ever be pulled out from under a verifikat.
 */
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { UpdateDimensionSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { deleteDimension, updateDimension } from '@/lib/dimensions/registry-service'
import { sessionFailureResponse } from '@/lib/operations/session'

ensureInitialized()

export const PATCH = withRouteContext(
  'dimension.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const opLog = log.child({ dimensionId: id })

    const result = await validateBody(request, UpdateDimensionSchema, {
      log: opLog,
      operation: 'dimension.update',
    })
    if (!result.success) return result.response

    const outcome = await updateDimension({ supabase, companyId, userId: user.id, log: opLog }, id, result.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, opLog, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext(
  'dimension.delete',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const opLog = log.child({ dimensionId: id })

    const outcome = await deleteDimension({ supabase, companyId, userId: user.id, log: opLog }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, opLog, requestId)
    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
