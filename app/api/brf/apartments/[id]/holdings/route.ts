import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { InitialBrfHoldingSchema } from '@/lib/api/schemas'
import { assignInitialHolder, listHoldings } from '@/lib/brf/apartment-register'
import { brfRegisterErrorResponse } from '@/lib/brf/route-helpers'
import { requireBrfForm } from '@/lib/company/brf-tax-profile'

/**
 * GET  /api/brf/apartments/[id]/holdings[?open=true]: who holds the apartment
 *      and who held it (BRL 9 kap. 10 § p. 3).
 * POST /api/brf/apartments/[id]/holdings: the first upplåtelse or a register
 *      load; every later change of holder goes through /api/brf/transfers.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'brf.holdings_list',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      await requireBrfForm(supabase, companyId)
      const openOnly = new URL(request.url).searchParams.get('open') === 'true'
      const data = await listHoldings(supabase, companyId, { apartmentId: id, openOnly })
      return NextResponse.json({ data })
    } catch (err) {
      return brfRegisterErrorResponse(err, log, requestId)
    }
  },
)

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'brf.holding_assign',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, InitialBrfHoldingSchema, {
      log,
      operation: 'brf.holding_assign',
    })
    if (!validation.success) return validation.response
    try {
      await requireBrfForm(supabase, companyId)
      const data = await assignInitialHolder(supabase, companyId, user.id, id, validation.data)
      return NextResponse.json({ data }, { status: 201 })
    } catch (err) {
      return brfRegisterErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
