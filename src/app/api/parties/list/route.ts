import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { PartiesListQuerySchema } from '@/lib/api/schemas'
import { getCounterpartList } from '@/lib/parties/list'

/**
 * GET /api/parties/list: Motparter as one flat list for the active company,
 * parties and resolver readings alike, with money from the bank side when
 * there is one and from the ledger otherwise.
 */
export const GET = withRouteContext('parties.counterparts', async (request, { supabase, companyId, log }) => {
  const validated = validateQuery(request, PartiesListQuerySchema, { log, operation: 'parties.counterparts' })
  if (!validated.success) return validated.response
  const { q, period } = validated.data
  const list = await getCounterpartList(supabase, companyId, { q, period })
  return NextResponse.json({ data: list })
})
