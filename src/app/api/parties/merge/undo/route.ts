import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { PartyUndoMergeSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/** POST /api/parties/merge/undo: restore the parties one merge decision folded, within 30 days. */
export const POST = withRouteContext(
  'parties.merge.undo',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, PartyUndoMergeSchema, { log, operation: 'parties.merge.undo' })
    if (!validation.success) return validation.response
    const { data, error } = await supabase.rpc('undo_party_merge', {
      p_company_id: companyId,
      p_user_id: user.id,
      p_decision_id: validation.data.decisionId,
    })
    if (error) {
      if (error.code === '23503') return errorResponseFromCode('NOT_FOUND', log, { requestId })
      throw new Error(`undo_party_merge failed: ${error.message}`)
    }
    return NextResponse.json({ data: { restored: Number(data) || 0 } })
  },
  { requireWrite: true },
)
