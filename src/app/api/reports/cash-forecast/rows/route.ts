import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createManualForecastRow, CreateManualForecastRowInput } from '@/lib/forecast/rows'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * POST /api/reports/cash-forecast/rows: a person adds money they expect in
 * or out to the Likviditetsprognos (source manual, no outside key). Not
 * bookkeeping: the row never reaches a verifikat. The API's door for the same
 * is POST /api/v1/.../cash-forecast-rows, keyed by the caller's own system.
 */
export const POST = withRouteContext(
  'report.cash_forecast.add_row',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const body = await validateBody(request, CreateManualForecastRowInput, { log, operation: 'report.cash_forecast.add_row' })
    if (!body.success) return body.response
    const outcome = await createManualForecastRow({ supabase, companyId, userId: user.id, log }, body.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
