import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { PartiesRegisterQuerySchema } from '@/lib/api/schemas'
import { getRegister } from '@/lib/parties/register'

/**
 * GET /api/parties: the Kontakter register for the active company. One
 * response carries the counts for every view plus the rows of the requested
 * view, so the segmented switch never waits on a second request.
 */
export const GET = withRouteContext('parties.list', async (request, { supabase, companyId, log }) => {
  const validated = validateQuery(request, PartiesRegisterQuerySchema, { log, operation: 'parties.list' })
  if (!validated.success) return validated.response
  const { view, q, period } = validated.data
  const register = await getRegister(supabase, companyId, { view, q, period })
  return NextResponse.json({ data: register })
})
