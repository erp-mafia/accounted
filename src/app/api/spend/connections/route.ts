import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { resolveOAuthOrigin } from '@/lib/auth/oauth-flows'
import { sessionFailureResponse } from '@/lib/operations/session'
import { SpendConnectBodySchema } from '@/lib/spend/schemas'
import { listSpendConnections, startSpendConnect } from '@/lib/spend/service'

/**
 * The company's spend connections (company card and spend platforms through
 * Accounted Connect).
 *
 * GET  the connections, ended ones included, with their health and accounts.
 * POST { provider }: start connecting through the provider's consent page.
 *      Answers with authorize_url; the browser goes there and comes back to
 *      /api/spend/connections/return.
 *
 * Rules live in lib/spend/service.ts, shared with the operations
 * (spend.connections-list). Nothing here books.
 */
export const GET = withRouteContext('spend.connections.list', async (_request, ctx) => {
  const { supabase, companyId, user, log, requestId } = ctx
  const outcome = await listSpendConnections({ supabase, companyId: companyId!, userId: user.id, log }, { include_ended: true })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) throw new Error('unreachable: a read')
  return NextResponse.json({ data: outcome.data })
})

export const POST = withRouteContext(
  'spend.connect',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const body = await validateBody(request, SpendConnectBodySchema, { log, operation: 'spend.connect' })
    if (!body.success) return body.response
    // The origin the person started on, validated: the app or a brand domain.
    const returnOrigin = await resolveOAuthOrigin(request)
    const outcome = await startSpendConnect(
      { supabase, companyId: companyId!, userId: user.id, log },
      { provider: body.data.provider, return_origin: returnOrigin },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('unreachable: no dry run on the dashboard')
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
