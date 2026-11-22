import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { generateResultatrapport } from '@/lib/reports/resultatrapport'
import { parseReportDateRange } from '@/lib/reports/date-range'
import { parseDimensionFilterParams } from '@/lib/reports/dimension-filter'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { parseBudgetParam, ReportBudgetError } from '@/lib/budgets/report-budget'

export const GET = withRouteContext('report.resultatrapport', async (request, { supabase, companyId, log, requestId }) => {
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end')
    .eq('id', periodId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (periodError) throw periodError
  // A period_id that is not the active company's (a page still holding the
  // previous company's year right after a company switch) is a stale request,
  // not a failure: say so, and generate nothing from another company's period.
  if (!period) {
    return errorResponseFromCode('PERIOD_NOT_FOUND', log.child({ periodId }), { requestId })
  }

  const parsed = parseReportDateRange(searchParams, period)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }

  const dimFilter = parseDimensionFilterParams(searchParams)
  if (!dimFilter.ok) {
    return NextResponse.json({ error: dimFilter.error }, { status: 400 })
  }

  const budgetParam = parseBudgetParam(searchParams)
  if (!budgetParam.ok) {
    return NextResponse.json({ error: budgetParam.error }, { status: 400 })
  }

  try {
    const result = await generateResultatrapport(supabase, companyId, periodId, {
      ...parsed.range,
      dimensions: dimFilter.dimensions,
      budgetId: budgetParam.budgetId,
    })
    return NextResponse.json({ data: result })
  } catch (err) {
    if (err instanceof ReportBudgetError) return errorResponseFromCode(err.code, log, { requestId })
    log.error('resultatrapport generation failed', err as Error, { periodId })
    return NextResponse.json(
      { error: err instanceof Error ? getUserErrorMessage(err) : 'Failed to generate resultatrapport' },
      { status: 500 }
    )
  }
})
