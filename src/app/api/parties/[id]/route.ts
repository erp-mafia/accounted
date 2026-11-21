import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getDossier, type RegisterPeriod } from '@/lib/parties/register'
import { isScbConfigured } from '@/lib/parties/scb/config'

/**
 * GET /api/parties/[id]: the dossier for one party (facts, identities,
 * decisions, vouchers). ?period=12m reads its ledger stats for the last 12
 * months, as the Parter list it opens from; anything else is the whole history.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'parties.get',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    if (!/^[0-9a-f-]{36}$/i.test(id)) return errorResponseFromCode('NOT_FOUND', log, { requestId })
    const period: RegisterPeriod = new URL(request.url).searchParams.get('period') === '12m' ? '12m' : 'all'
    const dossier = await getDossier(supabase, companyId, id, 0, period)
    if (!dossier) return errorResponseFromCode('NOT_FOUND', log, { requestId })
    return NextResponse.json({ data: dossier, scbConfigured: isScbConfigured() })
  },
)
