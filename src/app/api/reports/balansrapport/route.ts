import { NextResponse } from 'next/server'
import { generateBalansrapport } from '@/lib/reports/balansrapport'
import { withRouteContext } from '@/lib/api/with-route-context'
import { parseReportDateRange } from '@/lib/reports/date-range'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

export const GET = withRouteContext('report.balansrapport', async (request, { supabase, companyId, log, requestId }) => {
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

  try {
    const result = await generateBalansrapport(supabase, companyId, periodId, parsed.range)
    return NextResponse.json({ data: result })
  } catch (err) {
    log.error('balansrapport generation failed', err as Error, { periodId })
    return NextResponse.json(
      { error: err instanceof Error ? getUserErrorMessage(err) : 'Failed to generate balansrapport' },
      { status: 500 }
    )
  }
})
