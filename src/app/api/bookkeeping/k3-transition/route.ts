import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { errorResponse } from '@/lib/errors/get-structured-error'
import {
  deleteK3Transition,
  getK3Transition,
  k3TransitionYear,
  startK3Transition,
  StartK3TransitionSchema,
  updateK3Transition,
  UpdateK3TransitionSchema,
} from '@/lib/bokslut/k3-transition/transition-service'

const QuerySchema = z.object({ fiscal_period_id: z.string().uuid().optional() }).strict()

/**
 * The company's transition to K3 (BFNAR 2012:1 kap. 35): the first K3 year,
 * the 35.27 choice and the note facts, and the assets the 35.18 split
 * concerns. Null transition: not started. With fiscal_period_id, also that
 * year's framework, so the year-end wizard knows whether to offer it.
 */
export const GET = withRouteContext('k3_transition.get', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const query = validateQuery(request, QuerySchema, { log, operation: 'k3_transition.get' })
  if (!query.success) return query.response
  try {
    const [state, year] = await Promise.all([
      getK3Transition(supabase, companyId),
      query.data.fiscal_period_id ? k3TransitionYear(supabase, companyId, query.data.fiscal_period_id) : null,
    ])
    return NextResponse.json({ data: { ...state, year } })
  } catch (err) {
    return errorResponse(err, log, { requestId })
  }
})

/** Start the transition on the first K3 year (an open year reported under K3). */
export const POST = withRouteContext(
  'k3_transition.start',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, StartK3TransitionSchema)
    if (!validation.success) return validation.response
    try {
      const data = await startK3Transition(supabase, companyId, user.id, validation.data)
      return NextResponse.json({ data }, { status: 201 })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)

/** The 35.27 relief, the relief rules applied (35.31) and the principles changed (35.33). */
export const PATCH = withRouteContext(
  'k3_transition.update',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, UpdateK3TransitionSchema)
    if (!validation.success) return validation.response
    try {
      return NextResponse.json({ data: await updateK3Transition(supabase, companyId, validation.data) })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)

/** Drop a transition that is not committed and has no component splits left. */
export const DELETE = withRouteContext(
  'k3_transition.delete',
  async (_request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx
    try {
      await deleteK3Transition(supabase, companyId)
      return NextResponse.json({ data: { deleted: true } })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
