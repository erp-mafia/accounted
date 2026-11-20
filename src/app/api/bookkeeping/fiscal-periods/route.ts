import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateFiscalPeriodSchema } from '@/lib/api/schemas'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { createFiscalPeriod } from '@/lib/core/bookkeeping/fiscal-year-service'
import { sessionFailureResponse } from '@/lib/operations/session'

// GET keeps its legacy `{ error: string }` failure shape. POST answers the
// canonical `{ error: { code, message } }` envelope (the räkenskapsår UI reads
// error.message), and its success may carry a non-blocking `warnings` array
// (same shape as the invoice booking routes: `{ code, message }`).

export const GET = withRouteContext('period.list', async (_request, ctx) => {
  const { supabase, companyId } = ctx

  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('company_id', companyId)
    .order('period_start', { ascending: false })

  if (error) {
    return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
  }

  return NextResponse.json({ data })
})

/**
 * POST /api/bookkeeping/fiscal-periods: create a räkenskapsår. The rules (BFL
 * 3 kap. shape, contiguity with the neighbouring years, overlap 409, the
 * previous_period_id chain relink, the PRIOR_FISCAL_YEAR_STILL_OPEN advisory)
 * live in lib/core/bookkeeping/fiscal-year-service.ts, shared with the v1
 * operation fiscal-periods.create and gnubok_create_fiscal_period.
 */
export const POST = withRouteContext(
  'period.create',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx

    const validation = await validateBody(request, CreateFiscalPeriodSchema)
    if (!validation.success) return validation.response

    const outcome = await createFiscalPeriod({ supabase, companyId, userId: user.id, log }, validation.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })

    const data = outcome.data.fiscal_period
    const warnings = (outcome.warnings ?? []).map((w) => ({ code: w.code, message: w.message_sv }))
    return NextResponse.json(warnings.length > 0 ? { data, warnings } : { data })
  },
  { requireWrite: true },
)
