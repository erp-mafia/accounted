import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateAssociationDistributionSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { requireMemberCapitalForm } from '@/lib/associations/member-register'
import { createDistribution, listAllocations, listDistributions } from '@/lib/associations/distributions'
import { associationErrorResponse } from '@/lib/associations/route-helpers'

/**
 * GET  /api/associations/distributions?fiscal_period_id=...
 * POST /api/associations/distributions
 *
 * Värdeöverföringar to members (EFL 12-13 kap.): the decision on a
 * vinstutdelning on insatser or förlagsinsatser, or a gottgörelse, with its
 * allocation per member. Creating the row books nothing; the beloppsspärr
 * (EFL 12 kap. 2 §) is checked for the dividends. Book and pay through the
 * [id]/book and [id]/pay routes.
 */
export const GET = withRouteContext('association.distributions_list', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const fiscalPeriodId = new URL(request.url).searchParams.get('fiscal_period_id') ?? undefined
  if (fiscalPeriodId && !/^[0-9a-f-]{36}$/i.test(fiscalPeriodId)) {
    return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, reason: 'fiscal_period_id must be a uuid' })
  }
  try {
    await requireMemberCapitalForm(supabase, companyId)
    const distributions = await listDistributions(supabase, companyId, { fiscalPeriodId })
    const data = await Promise.all(
      distributions.map(async (distribution) => ({
        ...distribution,
        allocations: await listAllocations(supabase, companyId, distribution.id),
      })),
    )
    return NextResponse.json({ data })
  } catch (err) {
    return associationErrorResponse(err, log, requestId)
  }
})

export const POST = withRouteContext(
  'association.distribution_create',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, CreateAssociationDistributionSchema, {
      log,
      operation: 'association.distribution_create',
    })
    if (!validation.success) return validation.response
    if (validation.data.allocation_basis !== 'contributions' && !(validation.data.allocations?.length)) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        reason: 'allocations are required unless allocation_basis is contributions',
      })
    }
    try {
      await requireMemberCapitalForm(supabase, companyId)
      const { data: period, error } = await supabase
        .from('fiscal_periods')
        .select('id')
        .eq('id', validation.data.fiscal_period_id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (error) throw error
      if (!period) return errorResponseFromCode('FISCAL_PERIOD_NOT_FOUND', log, { requestId })
      const data = await createDistribution(supabase, companyId, user.id, validation.data)
      return NextResponse.json({ data }, { status: 201 })
    } catch (err) {
      return associationErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
