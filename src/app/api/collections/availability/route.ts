import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getCollectionsAvailability } from '@/lib/collections/availability'

/**
 * GET /api/collections/availability: what the collections and delivery UI
 * may render for the active company (lib/collections/availability.ts). Any
 * member may read it; it carries booleans, the connection's state and the
 * provider's public profile, never a credential or a customer detail.
 *
 * On an installation where collections is switched off it answers
 * start: 'hidden' without calling Connect.
 */
export const GET = withRouteContext('collections.availability', async (_request, { supabase, companyId }) => {
  const data = await getCollectionsAvailability(supabase, companyId)
  return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
})
