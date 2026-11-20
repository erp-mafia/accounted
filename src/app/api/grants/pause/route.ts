import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { setGrantsPaused } from '@/lib/grants/actions'

const PauseBodySchema = z.object({ paused: z.boolean() })

/**
 * POST /api/grants/pause
 *
 * The company's kill switch for its rules for automatic booking: paused =
 * true turns every grant off at once (claim_company_grant refuses before it
 * reads a rule), false turns them back on. An owner or admin only
 * (set_company_grants_paused asks the database the same predicate); every
 * change is a dated line in behandlingshistorik.
 */
export const POST = withRouteContext(
  'grant.pause',
  async (request, { supabase, companyId, log, requestId }) => {
    const validation = await validateBody(request, PauseBodySchema)
    if (!validation.success) return validation.response

    const outcome = await setGrantsPaused(supabase, companyId, validation.data.paused)
    if (!outcome.ok) return errorResponseFromCode(outcome.code, log, { requestId })
    return NextResponse.json({ data: { paused: outcome.paused, changed: outcome.changed } })
  },
  { requireAdmin: true },
)
