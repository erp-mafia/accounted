import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { privateNoStore } from '@/lib/api/private-no-store'
import { addDaysIso } from '@/lib/dates/iso'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildCashForecast } from '@/lib/forecast/build'
import { listForecastRows } from '@/lib/forecast/rows'
import { cashForecastGet } from '@/lib/operations/cash-forecast'
import { sessionFailureResponse } from '@/lib/operations/session'

/** Open rows dated before today the page lists for cancelling; older ones wait for the next page load. */
const PAST_ROWS_SHOWN = 100

/**
 * GET /api/reports/cash-forecast?weeks=13: the Likviditetsprognos page.
 * The same projection as GET /api/v1/.../cash-forecast (operation
 * cash-forecast.get, lib/forecast/build.ts), read as the signed-in member,
 * plus the open forecast rows dated before today that the projection leaves
 * out: the page offers to cancel them, which its caveat asks for. Rows that
 * point at an invoice are not among them; the invoice counts in their place.
 */
export const GET = withRouteContext('report.cash_forecast', async (request, { supabase, companyId, user, log, requestId }) => {
  const query = validateQuery(request, cashForecastGet.input, { log, operation: 'report.cash_forecast' })
  if (!query.success) return query.response

  let forecast
  try {
    forecast = await buildCashForecast(supabase, companyId, { weeks: query.data.weeks })
  } catch (err) {
    log.error('cash forecast failed', { error: err instanceof Error ? err.message : String(err) })
    return errorResponseFromCode('CASH_FORECAST_FAILED', log, { requestId })
  }

  const past = await listForecastRows(
    { supabase, companyId, userId: user.id, log },
    { status: 'open', to: addDaysIso(forecast.today, -1), limit: PAST_ROWS_SHOWN },
  )
  if (!past.ok) return sessionFailureResponse(past, log, requestId)
  if (past.dryRun) return errorResponseFromCode('CASH_FORECAST_ROWS_READ_FAILED', log, { requestId })
  const pastRows = past.data.rows.filter((row) => !row.invoice_id && !row.supplier_invoice_id)

  return privateNoStore(NextResponse.json({ data: { forecast, past_rows: pastRows } }))
})
