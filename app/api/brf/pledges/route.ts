import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateBrfPledgeSchema } from '@/lib/api/schemas'
import { listPledges, notifyPledge } from '@/lib/brf/apartment-register'
import { brfRegisterErrorResponse } from '@/lib/brf/route-helpers'
import { requireBrfForm } from '@/lib/company/brf-tax-profile'

/**
 * GET  /api/brf/pledges[?apartment_id=..][&open=true]
 * POST /api/brf/pledges: note a pantsättning in the lägenhetsförteckning
 *      (BRL 9 kap. 10 §). Released by PATCH /api/brf/pledges/[id], never deleted.
 */
export const GET = withRouteContext('brf.pledges_list', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const params = new URL(request.url).searchParams
  try {
    await requireBrfForm(supabase, companyId)
    const data = await listPledges(supabase, companyId, {
      apartmentId: params.get('apartment_id') ?? undefined,
      openOnly: params.get('open') === 'true',
    })
    return NextResponse.json({ data })
  } catch (err) {
    return brfRegisterErrorResponse(err, log, requestId)
  }
})

export const POST = withRouteContext(
  'brf.pledge_notify',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, CreateBrfPledgeSchema, {
      log,
      operation: 'brf.pledge_notify',
    })
    if (!validation.success) return validation.response
    try {
      await requireBrfForm(supabase, companyId)
      const data = await notifyPledge(supabase, companyId, user.id, validation.data)
      return NextResponse.json({ data }, { status: 201 })
    } catch (err) {
      return brfRegisterErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
