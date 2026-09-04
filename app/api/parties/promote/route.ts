import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { PartyPromoteSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * POST /api/parties/promote: confirm suggestions into roles. Each item
 * becomes a supplier and/or customer row filled from the party's facts;
 * undo through /api/parties/promote/undo for 30 days.
 */
export const POST = withRouteContext(
  'parties.promote',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, PartyPromoteSchema, { log, operation: 'parties.promote' })
    if (!validation.success) return validation.response
    const { data, error } = await supabase.rpc('promote_parties', {
      p_company_id: companyId,
      p_user_id: user.id,
      p_items: validation.data.items.map((i) => ({ party_id: i.partyId, roles: i.roles })),
    })
    if (error) {
      if (error.code === '23503') return errorResponseFromCode('NOT_FOUND', log, { requestId })
      throw new Error(`promote_parties failed: ${error.message}`)
    }
    const r = (data ?? {}) as Partial<Record<'parties' | 'suppliers' | 'customers', number>>
    return NextResponse.json({ data: { parties: r.parties ?? 0, suppliers: r.suppliers ?? 0, customers: r.customers ?? 0 } })
  },
  { requireWrite: true },
)
