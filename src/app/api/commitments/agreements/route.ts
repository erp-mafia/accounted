import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { createAgreement } from '@/lib/commitments/agreements'
import { CreateAgreementSchema } from '@/lib/commitments/schemas'

/**
 * POST /api/commitments/agreements: register an agreement by hand. Its
 * expected payments and its dates in Viktiga datum are written with it.
 */
export const POST = withRouteContext(
  'commitments.agreements.create',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, CreateAgreementSchema)
    if (!validation.success) return validation.response
    const outcome = await createAgreement({ supabase, companyId, userId: user.id }, validation.data, { dryRun: false })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
