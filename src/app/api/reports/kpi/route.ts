import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { parseDimensionFilterParams } from '@/lib/reports/dimension-filter'
import { generateKpiReport } from '@/lib/reports/kpi-report'
import { sessionFailureResponse } from '@/lib/operations/session'

// The report itself lives in lib/reports/kpi-report.ts, shared with the v1
// operation reports.kpi. This route keeps its success shape ({ data: KPIReport }).
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

  const outcome = await generateKpiReport(
    { supabase, companyId, userId: user.id, log },
    { period_id: periodId, dimensions: dimFilter.dimensions },
  )
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  return NextResponse.json({ data: outcome.dryRun ? outcome.preview : outcome.data })
})
