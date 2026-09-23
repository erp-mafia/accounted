import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { PartyUndoDecisionsSchema } from '@/lib/api/schemas'

/** POST /api/parties/promote/undo: reverse the latest promotion per party (30 days). */
export const POST = withRouteContext(
  'parties.promote.undo',
  async (request, { supabase, companyId, user, log }) => {
    const validation = await validateBody(request, PartyUndoDecisionsSchema, { log, operation: 'parties.promote.undo' })
    if (!validation.success) return validation.response
    const { data, error } = await supabase.rpc('undo_party_promotions', {
      p_company_id: companyId,
      p_user_id: user.id,
      p_party_ids: validation.data.partyIds,
    })
    if (error) throw new Error(`undo_party_promotions failed: ${error.message}`)
    return NextResponse.json({ data: { count: Number(data) || 0 } })
  },
  { requireWrite: true },
)
