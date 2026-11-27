import { NextResponse, after } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { sessionFailureResponse } from '@/lib/operations/session'
import { SpendConnectKeyBodySchema } from '@/lib/spend/schemas'
import { connectSpendWithApiKey, spendConnectDeps } from '@/lib/spend/service'
import { syncSpendConnection } from '@/lib/spend/sync'

/** A handful of tries an hour: a wrong key is a person retyping, never a loop. */
const RATE_LIMIT_KEY = { maxRequests: 10, windowMs: 60 * 60 * 1000 }

/**
 * POST { provider, api_key }: connect with an API key the provider issued
 * to the company. The key goes straight to Accounted Connect, which keeps
 * it; this ledger stores only the connection handle. The first fetch runs
 * right after the answer. Rules in lib/spend/service.ts.
 */
export const POST = withRouteContext(
  'spend.connect_key',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const body = await validateBody(request, SpendConnectKeyBodySchema, { log, operation: 'spend.connect_key' })
    if (!body.success) return body.response
    const rl = await checkRateLimit({ prefix: 'spend:connect_key', identifier: companyId!, ...RATE_LIMIT_KEY })
    if (!rl.ok) return rl.response!
    const outcome = await connectSpendWithApiKey({ supabase, companyId: companyId!, userId: user.id, log }, body.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('unreachable: no dry run on the dashboard')
    const connectionId = outcome.data.connection.id
    after(async () => {
      try {
        await syncSpendConnection(createServiceClientNoCookies(), connectionId, { log, connect: spendConnectDeps() })
      } catch (err) {
        log.error('first spend fetch after connect failed', err as Error, { connectionId })
      }
    })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
