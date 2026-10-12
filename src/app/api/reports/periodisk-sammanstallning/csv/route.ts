import type { PsPeriodType } from '@/lib/reports/periodisk-sammanstallning'
import { getPeriodiskSammanstallningCsv } from '@/lib/reports/filing-report-service'
import { sessionFailureResponse } from '@/lib/operations/session'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET /api/reports/periodisk-sammanstallning/csv
 *
 * Returns the SKV574008-formatted CSV file for upload to Skatteverket.
 * Refuses (400) if the report has any blocking warnings.
 */
export const GET = withRouteContext(
  'report.periodisk_sammanstallning.csv',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodType = searchParams.get('periodType') as PsPeriodType | null
    const yearStr = searchParams.get('year')
    const periodStr = searchParams.get('period')

    if (!periodType || !yearStr || !periodStr) {
      return errorResponseFromCode('PS_REPORT_MISSING_PARAMS', log, { requestId })
    }
    if (periodType !== 'monthly' && periodType !== 'quarterly') {
      return errorResponseFromCode('PS_REPORT_INVALID_PERIOD_TYPE', log, {
        requestId, details: { received: periodType },
      })
    }
    const year = parseInt(yearStr, 10)
    const period = parseInt(periodStr, 10)
    if (isNaN(year) || year < 2000 || year > 2100) {
      return errorResponseFromCode('PS_REPORT_INVALID_YEAR', log, { requestId })
    }
    if (isNaN(period)) {
      return errorResponseFromCode('PS_REPORT_INVALID_PERIOD', log, { requestId })
    }
    if (periodType === 'monthly' && (period < 1 || period > 12)) {
      return errorResponseFromCode('PS_REPORT_INVALID_PERIOD', log, { requestId })
    }
    if (periodType === 'quarterly' && (period < 1 || period > 4)) {
      return errorResponseFromCode('PS_REPORT_INVALID_PERIOD', log, { requestId })
    }

    // Filer info, blocking warnings and the file itself: the same service as
    // the v1 /reports/periodisk-sammanstallning/csv download.
    const outcome = await getPeriodiskSammanstallningCsv(
      { supabase, companyId, userId: user.id, log },
      { period_type: periodType, year, period },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return errorResponseFromCode('PS_REPORT_GENERATION_FAILED', log, { requestId })

    return new Response(new Uint8Array(outcome.data.bytes), {
      status: 200,
      headers: {
        'Content-Type': outcome.data.contentType,
        'Content-Disposition': `attachment; filename="${outcome.data.filename}"`,
        'X-Request-Id': requestId,
      },
    })
  }, { requireCompleteLedger: true })
