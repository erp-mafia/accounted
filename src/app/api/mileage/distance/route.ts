import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { MileageDistanceQuerySchema } from '@/lib/api/schemas'
import { fetchDistanceSuggestion } from '@/lib/mileage/distance'
import { guardSandbox } from '@/lib/sandbox/guard'

ensureInitialized()

// Proxies the OSM lookups server-side: the user's addresses never reach
// Nominatim/OSRM from their own browser, and the shared politeness caches
// live here. The sandbox guard keeps demo traffic off the public OSM
// budget, mirroring /api/currency/rate.
export const GET = withRouteContext('mileage.distance', async (request, { supabase, companyId }) => {
  const params = validateQuery(request, MileageDistanceQuerySchema)
  if (!params.success) return params.response

  const blocked = await guardSandbox(supabase, companyId)
  if (blocked) return blocked

  // null simply means "no suggestion": the form shows nothing.
  const suggestion = await fetchDistanceSuggestion(params.data.from, params.data.to)
  return NextResponse.json({ data: suggestion })
})
