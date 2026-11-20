import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { splitAssetAtTransition, TransitionSplitSchema } from '@/lib/bokslut/assets/transition-split-service'

type Params = { params: Promise<{ id: string }> }

/**
 * Split a plain asset on significant components at the transition to K3
 * (K3 35.18): each component's carrying amount at the transition date and
 * its useful life. The split books nothing. An empty list undoes it while
 * nothing is posted per component.
 */
export const PUT = withRouteContext<Params>(
  'assets.transition_split',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, TransitionSplitSchema)
    if (!validation.success) return validation.response
    try {
      const asset = await splitAssetAtTransition(supabase, companyId, id, validation.data)
      return NextResponse.json({ data: asset })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
