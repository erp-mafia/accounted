import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { findRcBasisGaps } from '@/lib/reports/rc-basis-gaps'
import {
  rcBasisSupplierDefaults,
  type RcBasisGapWithDefault,
  type RcBasisSupplierDefault,
} from '@/lib/vat/rc-basis-supplier-default'
import type { VatPeriodType } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

export const GET = withRouteContext(
  'report.vat_declaration.rc_basis_gaps',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodType = searchParams.get('periodType') as VatPeriodType | null
    const yearStr = searchParams.get('year')
    const periodStr = searchParams.get('period')
    // Yearly (helårsmoms) resolves against the räkenskapsår, mirroring the
    // declaration route; monthly/quarterly ignore it.
    const fiscalPeriodId = searchParams.get('fiscal_period_id') ?? undefined

    if (!periodType || !yearStr || !periodStr) {
      return errorResponseFromCode('VAT_REPORT_MISSING_PARAMS', log, { requestId })
    }
    if (!['monthly', 'quarterly', 'yearly'].includes(periodType)) {
      return errorResponseFromCode('VAT_REPORT_INVALID_PERIOD_TYPE', log, {
        requestId,
        details: { received: periodType },
      })
    }

    const year = parseInt(yearStr, 10)
    const period = parseInt(periodStr, 10)
    if (isNaN(year) || isNaN(period)) {
      return errorResponseFromCode('VAT_REPORT_INVALID_PERIOD', log, {
        requestId,
        details: { year: yearStr, period: periodStr },
      })
    }

    try {
      const scanned = await findRcBasisGaps(supabase, companyId, periodType, year, period, {
        fiscalPeriodId,
      })
      // Where each row's Korrigera picker starts (crm#1431). A failed read
      // starts every picker empty, which only asks the person to choose.
      let defaults = new Map<string, RcBasisSupplierDefault>()
      try {
        defaults = await rcBasisSupplierDefaults(supabase, companyId, scanned.map((g) => g.entryId))
      } catch (err) {
        log.warn('rc-basis-gaps supplier defaults unavailable, pickers start empty', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      const gaps: RcBasisGapWithDefault[] = scanned.map((g) => ({
        ...g,
        supplierDefault: defaults.get(g.entryId) ?? null,
      }))
      return NextResponse.json({ data: { gaps } })
    } catch (err) {
      log.error('rc-basis-gaps detection failed', err as Error, { periodType, year, period })
      return errorResponseFromCode('VAT_REPORT_GENERATION_FAILED', log, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
)
