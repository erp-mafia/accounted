import { NextResponse } from 'next/server'
import {
  calculateVatDeclaration,
  formatPeriodLabel,
} from '@/lib/reports/vat-declaration'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { VatPeriodType, AccountingMethod } from '@/types'

/**
 * GET /api/reports/vat-declaration
 *
 * Query parameters:
 *   periodType: 'monthly' | 'quarterly' | 'yearly'
 *   year:       number (e.g., 2025)
 *   period:     number (1-12 for monthly, 1-4 for quarterly, 1 for yearly)
 */
export const GET = withRouteContext(
  'report.vat_declaration',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodType = searchParams.get('periodType') as VatPeriodType | null
    const yearStr = searchParams.get('year')
    const periodStr = searchParams.get('period')
    // For yearly (helårsmoms) the period is the räkenskapsår, not the calendar
    // year; the client passes the selected fiscal period so an extended year is
    // covered in full. Ignored for monthly/quarterly (calendar periods).
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

    if (isNaN(year) || year < 2000 || year > 2100) {
      return errorResponseFromCode('VAT_REPORT_INVALID_YEAR', log, {
        requestId,
        details: { received: yearStr },
      })
    }

    if (isNaN(period)) {
      return errorResponseFromCode('VAT_REPORT_INVALID_PERIOD', log, {
        requestId,
        details: { received: periodStr },
      })
    }

    if (periodType === 'monthly' && (period < 1 || period > 12)) {
      return errorResponseFromCode('VAT_REPORT_INVALID_PERIOD', log, {
        requestId,
        details: { periodType, received: period, allowed: '1-12' },
      })
    }
    if (periodType === 'quarterly' && (period < 1 || period > 4)) {
      return errorResponseFromCode('VAT_REPORT_INVALID_PERIOD', log, {
        requestId,
        details: { periodType, received: period, allowed: '1-4' },
      })
    }
    if (periodType === 'yearly' && period !== 1) {
      return errorResponseFromCode('VAT_REPORT_INVALID_PERIOD', log, {
        requestId,
        details: { periodType, received: period, allowed: '1' },
      })
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = (settings?.accounting_method as AccountingMethod) || 'accrual'

    try {
      const declaration = await calculateVatDeclaration(
        supabase, companyId!, periodType, year, period, accountingMethod,
        { fiscalPeriodId },
      )

      return NextResponse.json({
        data: {
          ...declaration,
          // For yearly the authoritative span is declaration.period.start/end
          // (the räkenskapsår). The label stays a coarse "Helår {year}".
          periodLabel: formatPeriodLabel(periodType, year, period),
        },
      })
    } catch (err) {
      log.error('vat declaration calculation failed', err as Error, {
        periodType,
        year,
        period,
      })
      return errorResponseFromCode('VAT_REPORT_GENERATION_FAILED', log, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
)
