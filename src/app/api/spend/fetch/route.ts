import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { sessionFailureResponse } from '@/lib/operations/session'
import { SpendFetchBodySchema } from '@/lib/spend/schemas'
import { fetchSpendNow } from '@/lib/spend/service'

// A few pages of expenses through Connect, each with its receipts.
export const maxDuration = 300

/** The cron runs every five minutes; a person needs a handful more. */
const RATE_LIMIT_FETCH = { maxRequests: 12, windowMs: 60 * 60 * 1000 }

/**
 * "Hämta nu": receive waiting expenses now instead of waiting for the next
 * run. Nothing is booked. Rules in lib/spend/service.ts, shared with the
 * operation spend.fetch.
 */
export const POST = withRouteContext(
  'spend.fetch',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const body = await validateBody(request, SpendFetchBodySchema, { log, operation: 'spend.fetch' })
    if (!body.success) return body.response
    const rl = await checkRateLimit({ prefix: 'spend:fetch', identifier: companyId!, ...RATE_LIMIT_FETCH })
    if (!rl.ok) return rl.response!
    const outcome = await fetchSpendNow({ supabase, companyId: companyId!, userId: user.id, log }, body.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('unreachable: no dry run on the dashboard')
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
