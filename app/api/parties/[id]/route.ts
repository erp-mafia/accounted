import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getDossier } from '@/lib/parties/register'
import { isScbConfigured } from '@/lib/parties/scb/config'

/** GET /api/parties/[id]: the dossier for one party (facts, identities, decisions, vouchers). */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'parties.get',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    if (!/^[0-9a-f-]{36}$/i.test(id)) return errorResponseFromCode('NOT_FOUND', log, { requestId })
    const dossier = await getDossier(supabase, companyId, id)
    if (!dossier) return errorResponseFromCode('NOT_FOUND', log, { requestId })
    return NextResponse.json({ data: dossier, scbConfigured: isScbConfigured() })
  },
)
