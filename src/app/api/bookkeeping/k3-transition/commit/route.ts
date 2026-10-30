import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { commitK3TransitionPosting, K3TransitionPostingSchema } from '@/lib/bokslut/k3-transition/transition-service'

/**
 * Commit the transition to K3: the transition voucher (K3 35.11; none when
 * there is nothing to book) and the transition marked committed, in one
 * transaction. Reversing the voucher (storno) opens it again.
 */
export const POST = withRouteContext(
  'k3_transition.commit',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, K3TransitionPostingSchema)
    if (!validation.success) return validation.response
    try {
      const result = await commitK3TransitionPosting(supabase, companyId, user.id, validation.data)
      return NextResponse.json({ data: result })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
