import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { updateAgreement } from '@/lib/commitments/agreements'
import { UpdateAgreementSchema } from '@/lib/commitments/schemas'

/** PATCH /api/commitments/agreements/:id: change a manual agreement; its payments and dates follow. */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'commitments.agreements.update',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, UpdateAgreementSchema)
    if (!validation.success) return validation.response
    const outcome = await updateAgreement({ supabase, companyId, userId: user.id }, id, validation.data, { dryRun: false })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
