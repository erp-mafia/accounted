import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateBrfApartmentSchema } from '@/lib/api/schemas'
import { createApartment, listApartments } from '@/lib/brf/apartment-register'
import { brfRegisterErrorResponse } from '@/lib/brf/route-helpers'
import { requireBrfForm } from '@/lib/company/brf-tax-profile'

/**
 * GET  /api/brf/apartments
 * POST /api/brf/apartments
 *
 * The lägenhetsförteckning of a bostadsrättsförening (BRL 9 kap. 8 and 10
 * §§). Every other legal form gets 409.
 */
export const GET = withRouteContext('brf.apartments_list', async (_request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  try {
    await requireBrfForm(supabase, companyId)
    const data = await listApartments(supabase, companyId)
    return NextResponse.json({ data })
  } catch (err) {
    return brfRegisterErrorResponse(err, log, requestId)
  }
})

export const POST = withRouteContext(
  'brf.apartment_create',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, CreateBrfApartmentSchema, {
      log,
      operation: 'brf.apartment_create',
    })
    if (!validation.success) return validation.response
    try {
      await requireBrfForm(supabase, companyId)
      const data = await createApartment(supabase, companyId, user.id, validation.data)
      return NextResponse.json({ data }, { status: 201 })
    } catch (err) {
      return brfRegisterErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
