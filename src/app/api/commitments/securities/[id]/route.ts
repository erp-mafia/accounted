import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { updateSecurity } from '@/lib/commitments/securities'
import { UpdateSecuritySchema } from '@/lib/commitments/schemas'

/** PATCH /api/commitments/securities/:id: change one, or release it with valid_to. */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'commitments.securities.update',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, UpdateSecuritySchema)
    if (!validation.success) return validation.response
    const outcome = await updateSecurity({ supabase, companyId, userId: user.id }, id, validation.data, { dryRun: false })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
