import { NextResponse } from 'next/server'
import {
  generatePeriodiskSammanstallning,
  reconcilePsAgainstVatDeclaration,
  type PsPeriodType,
} from '@/lib/reports/periodisk-sammanstallning'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { MomsPeriod } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/reports/periodisk-sammanstallning
 *
 * Query parameters:
 *   periodType: 'monthly' | 'quarterly'
 *   year:       number (e.g., 2025)
 *   period:     number (1-12 for monthly, 1-4 for quarterly)
 */
export const GET = withRouteContext(
  'report.periodisk_sammanstallning',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodType = searchParams.get('periodType') as PsPeriodType | null
    const yearStr = searchParams.get('year')
    const periodStr = searchParams.get('period')

    if (!periodType || !yearStr || !periodStr) {
      return errorResponseFromCode('PS_REPORT_MISSING_PARAMS', log, { requestId })
    }

    if (periodType !== 'monthly' && periodType !== 'quarterly') {
      return errorResponseFromCode('PS_REPORT_INVALID_PERIOD_TYPE', log, {
        requestId,
        details: { received: periodType },
      })
    }

    const year = parseInt(yearStr, 10)
    const period = parseInt(periodStr, 10)

    if (isNaN(year) || year < 2000 || year > 2100) {
      return errorResponseFromCode('PS_REPORT_INVALID_YEAR', log, {
        requestId,
        details: { received: yearStr },
      })
    }
    if (isNaN(period)) {
      return errorResponseFromCode('PS_REPORT_INVALID_PERIOD', log, {
        requestId,
        details: { received: periodStr },
      })
    }
    if (periodType === 'monthly' && (period < 1 || period > 12)) {
      return errorResponseFromCode('PS_REPORT_INVALID_PERIOD', log, {
        requestId,
        details: { periodType, received: period, allowed: '1-12' },
      })
    }
    if (periodType === 'quarterly' && (period < 1 || period > 4)) {
      return errorResponseFromCode('PS_REPORT_INVALID_PERIOD', log, {
        requestId,
        details: { periodType, received: period, allowed: '1-4' },
      })
    }

    try {
      const report = await generatePeriodiskSammanstallning(
        supabase, companyId, periodType, year, period,
      )

      // Best-effort reconciliation against momsdeklaration when periods coincide.
      const { data: settings } = await supabase
        .from('company_settings')
        .select('moms_period')
        .eq('company_id', companyId)
        .single()
      const momsPeriod = (settings?.moms_period ?? null) as MomsPeriod | null
      const reconciled = await reconcilePsAgainstVatDeclaration(
        supabase, companyId, report, momsPeriod,
      )

      return NextResponse.json({ data: reconciled })
    } catch (err) {
      log.error('periodisk sammanställning calculation failed', err as Error, {
        periodType, year, period,
      })
      return errorResponseFromCode('PS_REPORT_GENERATION_FAILED', log, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
)
