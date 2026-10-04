import { NextResponse, after } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { sessionFailureResponse } from '@/lib/operations/session'
import { PosConnectBodySchema } from '@/lib/pos-sales/schemas'
import { connectPosVenue, listPosConnections } from '@/lib/pos-sales/service'
import { syncPosConnection } from '@/lib/pos-sales/sync'

/**
 * The company's POS connections (kassasystem through Accounted Connect).
 *
 * GET  the connections, ended ones included, with their health and mapping.
 * POST { provider, venue_ref, sync_from? }: connect a venue that
 *      GET /api/pos-sales/venues listed. The first fetch runs right after the
 *      answer, so the days appear without waiting for the morning run.
 *
 * Rules live in lib/pos-sales/service.ts, shared with the operations
 * (pos-sales.connections-list, pos-sales.connect). Nothing here books.
 */
export const GET = withRouteContext('pos_sales.connections.list', async (_request, ctx) => {
  const { supabase, companyId, user, log, requestId } = ctx
  const outcome = await listPosConnections({ supabase, companyId: companyId!, userId: user.id, log }, { include_ended: true })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) throw new Error('unreachable: a read')
  return NextResponse.json({ data: outcome.data })
})

export const POST = withRouteContext(
  'pos_sales.connect',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const body = await validateBody(request, PosConnectBodySchema, { log, operation: 'pos_sales.connect' })
    if (!body.success) return body.response

    const outcome = await connectPosVenue({ supabase, companyId: companyId!, userId: user.id, log }, body.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('unreachable: no dry run on the dashboard')

    const connectionId = outcome.data.connection.id
    after(async () => {
      try {
        await syncPosConnection(createServiceClientNoCookies(), connectionId, { log })
      } catch (err) {
        log.error('first pos fetch after connect failed', err as Error, { connectionId })
      }
    })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
