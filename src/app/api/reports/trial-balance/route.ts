import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { parseReportDateRange } from '@/lib/reports/date-range'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/reports/trial-balance?period_id=&from_date=&to_date=
 *
 * Saldobalans for a räkenskapsår, or for a date range inside it: IB is the
 * balance the day before from_date, the period columns the activity in the
 * range and UB the balance at to_date (generateTrialBalance). Both dates are
 * optional and validated against the period like every ranged report.
 */
export const GET = withRouteContext('report.trial_balance', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end')
    .eq('id', periodId)
    .eq('company_id', companyId)
    .single()

  let range: { fromDate?: string; toDate?: string } = {}
  if (period) {
    const parsed = parseReportDateRange(searchParams, period)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }
    range = parsed.range
  }

  try {
    const result = await generateTrialBalance(supabase, companyId, periodId, { closingEntry: 'include', ...range })
    return NextResponse.json({ data: result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? getUserErrorMessage(err) : 'Failed to generate trial balance' },
      { status: 500 }
    )
  }
})
