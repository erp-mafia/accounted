import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { BrfTaxProfileSchema } from '@/lib/api/schemas'
import {
  BrfError,
  getTaxProfile,
  listTaxProfiles,
  requireBrfForm,
  upsertTaxProfile,
} from '@/lib/company/brf-tax-profile'
import { brfErrorResponse } from '@/lib/company/brf-route-helpers'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET /api/brf/tax-profile?fiscal_year=2026   (one year, 404 when unassessed)
 * GET /api/brf/tax-profile                    (every assessed year)
 * PUT /api/brf/tax-profile                    (assess or re-assess one year)
 *
 * The privatbostadsföretag assessment of a bostadsrättsförening (IL 2 kap.
 * 17 §): decided per taxation year, it tells the year-end tax step whether
 * the property result leaves the tax base (IL 39 kap. 25 §). Every other
 * legal form gets 409.
 */
export const GET = withRouteContext('brf.tax_profile_get', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  try {
    await requireBrfForm(supabase, companyId)
    const raw = new URL(request.url).searchParams.get('fiscal_year')
    if (raw === null) {
      const data = await listTaxProfiles(supabase, companyId)
      return NextResponse.json({ data })
    }
    const fiscalYear = Number(raw)
    if (!Number.isInteger(fiscalYear) || fiscalYear < 1990 || fiscalYear > 2200) {
      return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, reason: 'fiscal_year must be a year' })
    }
    const data = await getTaxProfile(supabase, companyId, fiscalYear)
    if (!data) throw new BrfError('BRF_TAX_PROFILE_NOT_FOUND')
    return NextResponse.json({ data })
  } catch (err) {
    return brfErrorResponse(err, log, requestId)
  }
})

export const PUT = withRouteContext(
  'brf.tax_profile_put',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, BrfTaxProfileSchema, {
      log,
      operation: 'brf.tax_profile_put',
    })
    if (!validation.success) return validation.response
    try {
      await requireBrfForm(supabase, companyId)
      const data = await upsertTaxProfile(supabase, companyId, user.id, validation.data)
      return NextResponse.json({ data })
    } catch (err) {
      return brfErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
