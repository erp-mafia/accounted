import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { listAvailableSpendProviders } from '@/lib/spend/service'

/**
 * The spend providers this installation can connect, as Accounted Connect
 * lists them. Empty while no provider is configured at Connect.
 */
export const GET = withRouteContext('spend.providers.list', async (_request, ctx) => {
  const { supabase, companyId, user, log, requestId } = ctx
  const outcome = await listAvailableSpendProviders({ supabase, companyId: companyId!, userId: user.id, log })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) throw new Error('unreachable: a read')
  return NextResponse.json({ data: outcome.data })
})
