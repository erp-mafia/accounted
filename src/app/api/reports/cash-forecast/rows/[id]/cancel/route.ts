import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isUuid } from '@/lib/invariants/uuid'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { cancelForecastRow } from '@/lib/forecast/rows'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * POST /api/reports/cash-forecast/rows/:id/cancel: the row leaves the
 * Likviditetsprognos and stays on record (never deleted). The same rule as
 * POST /api/v1/.../cash-forecast-rows/cancel: cancelling twice is once, and a
 * realised or superseded row cannot be cancelled.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'report.cash_forecast.cancel_row',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    if (!isUuid(id)) return errorResponseFromCode('CASH_FORECAST_ROW_NOT_FOUND', log, { requestId })
    const outcome = await cancelForecastRow({ supabase, companyId, userId: user.id, log }, { cash_forecast_row_id: id }, { dryRun: false })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
