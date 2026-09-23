import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { fetchClientOverview } from '@/lib/clients/fetch-client-overview'

/**
 * GET /api/clients
 *
 * Byrå cockpit aggregate (WL-14): one row per client company on the caller's
 * byrå team (teams.kind = 'byra') with the four at-a-glance signals: unbooked
 * transaction count, unconsumed inbox document count, next deadline
 * (status-engine semantics, 14-day ACTION_NEEDED window) and last booked
 * (latest posted verifikat date). Rows arrive urgency-sorted: overdue
 * deadlines first, then largest unbooked pile.
 *
 * Read-only across memberships (WL-09 read-first): RLS already allows these
 * reads via user_company_ids(); the active company is untouched.
 *
 * Non-byrå users get 403 FORBIDDEN: the cockpit is byrå-exclusive in v1
 * (multi-company self-users keep the company switcher).
 */
export const GET = withRouteContext('clients.list', async (_request, ctx) => {
  const overview = await fetchClientOverview(ctx.supabase, ctx.user.id)

  if (!overview) {
    return errorResponseFromCode('FORBIDDEN', ctx.log, {
      requestId: ctx.requestId,
      reason: 'not a byrå team member',
      messageSv: 'Klientlistan är endast tillgänglig för byråteam.',
      messageEn: 'The client list is only available to byrå team members.',
    })
  }

  return NextResponse.json({ data: overview })
})
