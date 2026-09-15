import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { apartmentCapitalReconciliation } from '@/lib/brf/apartment-register'
import { brfRegisterErrorResponse } from '@/lib/brf/route-helpers'
import { requireBrfForm } from '@/lib/company/brf-tax-profile'

/**
 * GET /api/brf/reconciliation?fiscal_period_id=...
 *
 * Insatser and upplåtelseavgifter of the apartments upplåtna med bostadsrätt
 * against the ledger balances on 2083 and 2087 (ÅRL 3 kap. 10 b §). A
 * difference is reported, never corrected.
 */
export const GET = withRouteContext('brf.reconciliation', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const fiscalPeriodId = new URL(request.url).searchParams.get('fiscal_period_id')
  if (!fiscalPeriodId || !/^[0-9a-f-]{36}$/i.test(fiscalPeriodId)) {
    return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, reason: 'fiscal_period_id is required' })
  }
  try {
    await requireBrfForm(supabase, companyId)
    const { data: period, error } = await supabase
      .from('fiscal_periods')
      .select('id')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw error
    if (!period) return errorResponseFromCode('FISCAL_PERIOD_NOT_FOUND', log, { requestId })
    const data = await apartmentCapitalReconciliation(supabase, companyId, fiscalPeriodId)
    return NextResponse.json({ data })
  } catch (err) {
    return brfRegisterErrorResponse(err, log, requestId)
  }
})
