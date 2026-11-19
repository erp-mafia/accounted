import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { createSecurity } from '@/lib/commitments/securities'
import { CreateSecuritySchema } from '@/lib/commitments/schemas'

/** POST /api/commitments/securities: register a ställd säkerhet or an eventualförpliktelse. */
export const POST = withRouteContext(
  'commitments.securities.create',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, CreateSecuritySchema)
    if (!validation.success) return validation.response
    const outcome = await createSecurity({ supabase, companyId, userId: user.id }, validation.data, { dryRun: false })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
