import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { parseDimensionFilterParams } from '@/lib/reports/dimension-filter'
import { generateKpiReport } from '@/lib/reports/kpi-report'
import { buildReportDataStatus } from '@/lib/reports/data-status'
import { sessionFailureResponse } from '@/lib/operations/session'

// The report itself lives in lib/reports/kpi-report.ts, shared with the v1
// operation reports.kpi. This route keeps its success shape ({ data: KPIReport })
// and adds data_status beside it: how current the figures are (unbooked bank
// rows in the period, the bank feed's last sync), the same block the MCP tool
// gnubok_get_kpi_report returns. Company-wide even under a dimension filter,
// like there. It never throws: an unreadable status comes back as
// { unavailable: true } and the report still answers.
export const GET = withRouteContext('report.kpi', async (request, { supabase, companyId, user, log, requestId }) => {
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')
  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  const dimFilter = parseDimensionFilterParams(searchParams)
  if (!dimFilter.ok) {
    return NextResponse.json({ error: dimFilter.error }, { status: 400 })
  }

  const [outcome, dataStatus] = await Promise.all([
    generateKpiReport(
      { supabase, companyId, userId: user.id, log },
      { period_id: periodId, dimensions: dimFilter.dimensions },
    ),
    buildReportDataStatus(supabase, companyId, { periodId }),
  ])
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  return NextResponse.json({
    data: outcome.dryRun ? outcome.preview : outcome.data,
    data_status: dataStatus,
  })
})
