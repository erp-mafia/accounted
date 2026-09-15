import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { BrfPropertyFactsSchema } from '@/lib/api/schemas'
import { getPropertyFacts, requireBrfForm, upsertPropertyFacts } from '@/lib/company/brf-tax-profile'
import { brfErrorResponse } from '@/lib/company/brf-route-helpers'

/**
 * GET /api/brf/property-facts
 * PUT /api/brf/property-facts
 *
 * The bostadsrättsförening's property facts (kvm, lägenheter, taxeringsvärde,
 * tomträtt, samfällighet, underhållsplan) behind the ÅRL 6 kap. 3 a §
 * nyckeltal and the fastighetsavgift. One row per company; every other legal
 * form gets 409.
 */
export const GET = withRouteContext('brf.property_facts_get', async (_request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  try {
    await requireBrfForm(supabase, companyId)
    const data = await getPropertyFacts(supabase, companyId)
    return NextResponse.json({ data })
  } catch (err) {
    return brfErrorResponse(err, log, requestId)
  }
})

export const PUT = withRouteContext(
  'brf.property_facts_put',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, BrfPropertyFactsSchema, {
      log,
      operation: 'brf.property_facts_put',
    })
    if (!validation.success) return validation.response
    try {
      await requireBrfForm(supabase, companyId)
      const data = await upsertPropertyFacts(supabase, companyId, user.id, validation.data)
      return NextResponse.json({ data })
    } catch (err) {
      return brfErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
