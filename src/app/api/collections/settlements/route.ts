import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { loadSettlementsOverview } from '@/lib/collections/settlements-view'

/**
 * GET /api/collections/settlements: the collections provider's payouts and
 * the payments the provider collected, with how far each is booked. Read
 * through the member's own client (RLS). An obligation path: served
 * whatever the start gates say, so a company can always finish booking what
 * the provider already paid.
 */
export const GET = withRouteContext('collections.settlements.list', async (_request, { supabase, companyId }) => {
  const data = await loadSettlementsOverview(supabase, companyId)
  return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
})
