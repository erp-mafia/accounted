import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { memberCapitalReconciliation, requireMemberCapitalForm } from '@/lib/associations/member-register'
import { associationErrorResponse } from '@/lib/associations/route-helpers'

/**
 * GET /api/associations/reconciliation?fiscal_period_id=...
 *
 * Register sums against the ledger balances on 2083/2087/2084 for the
 * period. A difference is reported, never corrected.
 */
export const GET = withRouteContext('association.reconciliation', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const fiscalPeriodId = new URL(request.url).searchParams.get('fiscal_period_id')
  if (!fiscalPeriodId || !/^[0-9a-f-]{36}$/i.test(fiscalPeriodId)) {
    return errorResponseFromCode('VALIDATION_ERROR', log, {
      requestId,
      reason: 'fiscal_period_id is required',
    })
  }
  try {
    await requireMemberCapitalForm(supabase, companyId)
    const { data: period, error } = await supabase
      .from('fiscal_periods')
      .select('id')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw error
    if (!period) return errorResponseFromCode('FISCAL_PERIOD_NOT_FOUND', log, { requestId })
    const data = await memberCapitalReconciliation(supabase, companyId, fiscalPeriodId)
    return NextResponse.json({ data })
  } catch (err) {
    return associationErrorResponse(err, log, requestId)
  }
})
