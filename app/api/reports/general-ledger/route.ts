import { NextResponse } from 'next/server'
import { generateGeneralLedger } from '@/lib/reports/general-ledger'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { parseDimensionFilterParams } from '@/lib/reports/dimension-filter'
import { parseReportDateRange, type DateRange } from '@/lib/reports/date-range'

export const GET = withRouteContext(
  'report.general_ledger',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodId = searchParams.get('period_id')
    const accountFrom = searchParams.get('account_from') || undefined
    const accountTo = searchParams.get('account_to') || undefined

    if (!periodId) {
      return errorResponseFromCode('REPORT_PERIOD_REQUIRED', log, { requestId })
    }

    const dimFilter = parseDimensionFilterParams(searchParams)
    if (!dimFilter.ok) {
      return NextResponse.json({ error: dimFilter.error }, { status: 400 })
    }

    // Validate the optional date sub-range against the fiscal period bounds.
    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
      .eq('id', periodId)
      .eq('company_id', companyId!)
      .single()

    let range: DateRange = {}
    if (period) {
      const parsed = parseReportDateRange(searchParams, period)
      if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 })
      }
      range = parsed.range
    }

    try {
      const data = await generateGeneralLedger(supabase, companyId!, periodId, accountFrom, accountTo, {
        dimensions: dimFilter.dimensions,
        fromDate: range.fromDate,
        toDate: range.toDate,
      })
      return NextResponse.json({ data })
    } catch (err) {
      // The raw error message is logged server-side only: it can carry
      // internal details (SQL, table names) that must not reach the client.
      log.error('general ledger generation failed', err as Error, { periodId })
      return errorResponseFromCode('REPORT_GENERATION_FAILED', log, { requestId })
    }
  },
)
