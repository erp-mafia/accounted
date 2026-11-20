import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { K3TransitionPostingSchema, previewK3Transition } from '@/lib/bokslut/k3-transition/transition-service'

/**
 * The transition voucher as it would be posted (K3 35.11): the opening
 * deferred tax with its temporary differences, the stated adjustments, all
 * against equity on the first day of the first K3 year. Writes nothing.
 */
export const POST = withRouteContext('k3_transition.preview', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const validation = await validateBody(request, K3TransitionPostingSchema)
  if (!validation.success) return validation.response
  try {
    return NextResponse.json({ data: await previewK3Transition(supabase, companyId, validation.data) })
  } catch (err) {
    return errorResponse(err, log, { requestId })
  }
})
