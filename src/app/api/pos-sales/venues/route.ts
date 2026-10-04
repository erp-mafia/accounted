import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { listAvailablePosVenues } from '@/lib/pos-sales/service'

/**
 * The POS venues Accounted Connect lists for this company's organisation
 * number, and per provider how a venue gets opened for Accounted. Rules in
 * lib/pos-sales/service.ts, shared with the operation pos-sales.venues-list.
 */
export const GET = withRouteContext('pos_sales.venues.list', async (_request, ctx) => {
  const { supabase, companyId, user, log, requestId } = ctx
  const outcome = await listAvailablePosVenues({ supabase, companyId: companyId!, userId: user.id, log })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) throw new Error('unreachable: a read')
  return NextResponse.json({ data: outcome.data })
})
