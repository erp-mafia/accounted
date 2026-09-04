import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { suggestPartiesForCompany } from '@/lib/parties/suggest'

/**
 * POST /api/parties/suggest: run the suggestion pipeline for the active
 * company. Idempotent: re-running attaches new evidence and creates nothing
 * a person already decided on.
 */
export const POST = withRouteContext(
  'parties.suggest',
  async (_request, { supabase, companyId, user, log }) => {
    const summary = await suggestPartiesForCompany(supabase, companyId, user.id)
    log.info('party suggestions refreshed', summary)
    return NextResponse.json({ data: summary })
  },
  { requireWrite: true },
)
