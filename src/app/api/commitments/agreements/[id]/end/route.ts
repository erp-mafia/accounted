import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { endAgreement } from '@/lib/commitments/agreements'
import { EndAgreementSchema } from '@/lib/commitments/schemas'

/** POST /api/commitments/agreements/:id/end: end a manual agreement (default today). */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'commitments.agreements.end',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, EndAgreementSchema)
    if (!validation.success) return validation.response
    const outcome = await endAgreement({ supabase, companyId, userId: user.id }, id, validation.data, { dryRun: false })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
