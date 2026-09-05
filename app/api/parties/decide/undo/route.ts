import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { PartyUndoDecisionsSchema } from '@/lib/api/schemas'

/** POST /api/parties/decide/undo: reverse the latest confirm or dismiss per party (30 days). */
export const POST = withRouteContext(
  'parties.decide.undo',
  async (request, { supabase, companyId, user, log }) => {
    const validation = await validateBody(request, PartyUndoDecisionsSchema, { log, operation: 'parties.decide.undo' })
    if (!validation.success) return validation.response
    const { data, error } = await supabase.rpc('undo_party_decisions', {
      p_company_id: companyId,
      p_user_id: user.id,
      p_party_ids: validation.data.partyIds,
    })
    if (error) throw new Error(`undo_party_decisions failed: ${error.message}`)
    return NextResponse.json({ data: { count: Number(data) || 0 } })
  },
  { requireWrite: true },
)
