import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { PartyMergeSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/** POST /api/parties/merge: soft-merge parties into a survivor; returns the decision id for undo. */
export const POST = withRouteContext(
  'parties.merge',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, PartyMergeSchema, { log, operation: 'parties.merge' })
    if (!validation.success) return validation.response
    const { survivorId, mergedIds, note } = validation.data
    if (mergedIds.includes(survivorId)) {
      return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, details: { field: 'mergedIds', reason: 'survivor_in_merged' } })
    }
    const { data, error } = await supabase.rpc('merge_parties', {
      p_company_id: companyId,
      p_user_id: user.id,
      p_survivor: survivorId,
      p_merged: mergedIds,
      p_note: note ?? null,
    })
    if (error) {
      if (error.code === '23503') return errorResponseFromCode('NOT_FOUND', log, { requestId })
      throw new Error(`merge_parties failed: ${error.message}`)
    }
    return NextResponse.json({ data: { decisionId: data as string, survivorId, mergedIds } })
  },
  { requireWrite: true },
)
