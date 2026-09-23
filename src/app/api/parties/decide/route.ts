import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { PartyDecideSchema } from '@/lib/api/schemas'

/** POST /api/parties/decide: bulk confirm or dismiss suggested parties. */
export const POST = withRouteContext(
  'parties.decide',
  async (request, { supabase, companyId, user, log }) => {
    const validation = await validateBody(request, PartyDecideSchema, { log, operation: 'parties.decide' })
    if (!validation.success) return validation.response
    const { partyIds, kind, note } = validation.data
    const { data, error } = await supabase.rpc('decide_parties', {
      p_company_id: companyId,
      p_user_id: user.id,
      p_party_ids: partyIds,
      p_kind: kind,
      p_note: note ?? null,
    })
    if (error) throw new Error(`decide_parties failed: ${error.message}`)
    return NextResponse.json({ data: { count: Number(data) || 0, kind } })
  },
  { requireWrite: true },
)
