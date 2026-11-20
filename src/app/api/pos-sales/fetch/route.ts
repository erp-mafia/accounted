import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { sessionFailureResponse } from '@/lib/operations/session'
import { PosFetchBodySchema } from '@/lib/pos-sales/schemas'
import { fetchPosSalesDays } from '@/lib/pos-sales/service'

// Up to six provider calls through Connect.
export const maxDuration = 300

/** The provider allows ten calls an hour per venue; a person needs a handful. */
const RATE_LIMIT_FETCH = { maxRequests: 6, windowMs: 60 * 60 * 1000 }

/**
 * "Hämta": fetch POS days now instead of waiting for the morning run, the
 * given closed days or the regular plan. Nothing is booked. Rules in
 * lib/pos-sales/service.ts, shared with the operation pos-sales.fetch.
 */
export const POST = withRouteContext(
  'pos_sales.fetch',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const body = await validateBody(request, PosFetchBodySchema, { log, operation: 'pos_sales.fetch' })
    if (!body.success) return body.response

    const rl = await checkRateLimit({ prefix: 'pos_sales:fetch', identifier: companyId!, ...RATE_LIMIT_FETCH })
    if (!rl.ok) return rl.response!

    const outcome = await fetchPosSalesDays({ supabase, companyId: companyId!, userId: user.id, log }, body.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('unreachable: no dry run on the dashboard')
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
