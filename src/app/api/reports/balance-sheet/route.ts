import { NextResponse } from 'next/server'
import { generateBalanceSheet } from '@/lib/reports/balance-sheet'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { parseReportDateRange } from '@/lib/reports/date-range'
import { buildReportDataStatus } from '@/lib/reports/data-status'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

export const GET = withRouteContext(
  'report.balance_sheet',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodId = searchParams.get('period_id')

    if (!periodId) {
      return errorResponseFromCode('REPORT_PERIOD_REQUIRED', log, { requestId })
    }

    const opLog = log.child({ periodId })

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
      // data_status beside the report (lib/reports/data-status.ts). The
      // balances at to_date carry every row from the period start, so the
      // status covers the period start to to_date, as the MCP balance sheet's.
      const [result, dataStatus] = await Promise.all([
        generateBalanceSheet(supabase, companyId!, periodId, range),
        buildReportDataStatus(supabase, companyId!, { periodId, toDate: range.toDate }),
      ])

      if (period) {
        result.period = {
          start: range.fromDate ?? period.period_start,
          end: range.toDate ?? period.period_end,
        }
      }

      return NextResponse.json({ data: result, data_status: dataStatus })
    } catch (err) {
      opLog.error('balance sheet generation failed', err as Error)
      return errorResponseFromCode('REPORT_GENERATION_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
)
