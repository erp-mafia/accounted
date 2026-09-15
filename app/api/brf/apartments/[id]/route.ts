import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateBrfApartmentSchema } from '@/lib/api/schemas'
import { getApartment, updateApartment } from '@/lib/brf/apartment-register'
import { brfRegisterErrorResponse } from '@/lib/brf/route-helpers'
import { requireBrfForm } from '@/lib/company/brf-tax-profile'

/**
 * GET   /api/brf/apartments/[id]
 * PATCH /api/brf/apartments/[id]: the non-identity fields (BRL 9 kap. 10 §).
 * The beteckning is the register key and is never changed; there is no
 * DELETE, an apartment that ceases to exist gets a note.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'brf.apartment_get',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      await requireBrfForm(supabase, companyId)
      const data = await getApartment(supabase, companyId, id)
      return NextResponse.json({ data })
    } catch (err) {
      return brfRegisterErrorResponse(err, log, requestId)
    }
  },
)

export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'brf.apartment_update',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, UpdateBrfApartmentSchema, {
      log,
      operation: 'brf.apartment_update',
    })
    if (!validation.success) return validation.response
    try {
      await requireBrfForm(supabase, companyId)
      const data = await updateApartment(supabase, companyId, id, validation.data)
      return NextResponse.json({ data })
    } catch (err) {
      return brfRegisterErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
