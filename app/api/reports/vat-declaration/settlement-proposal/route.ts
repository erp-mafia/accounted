import { NextResponse } from 'next/server'
import { buildVatSettlementProposal } from '@/lib/reports/vat-settlement'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { VatPeriodType } from '@/types'

/**
 * GET /api/reports/vat-declaration/settlement-proposal
 *
 * Builds the momsredovisning verifikat proposal for a VAT period (issue #980):
 * the editable lines that clear the period's 26xx accounts to 2650/1650. The
 * proposal is computed from the same ledger projection as the momsrapport;
 * booking happens separately through POST /api/bookkeeping/journal-entries
 * with source_type 'vat_settlement' once the user has reviewed the lines.
 *
 * Query parameters (same shape as /api/reports/vat-declaration):
 *   periodType:       'monthly' | 'quarterly' | 'yearly'
 *   year:             number (e.g., 2026)
 *   period:           number (1-12 monthly, 1-4 quarterly, 1 yearly)
 *   fiscal_period_id: optional; yearly only (räkenskapsår bounds)
 */
export const GET = withRouteContext(
  'report.vat_settlement_proposal',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodType = searchParams.get('periodType') as VatPeriodType | null
    const yearStr = searchParams.get('year')
    const periodStr = searchParams.get('period')
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

    if (
      isNaN(period) ||
      (periodType === 'monthly' && (period < 1 || period > 12)) ||
      (periodType === 'quarterly' && (period < 1 || period > 4)) ||
      (periodType === 'yearly' && period !== 1)
    ) {
      return errorResponseFromCode('VAT_REPORT_INVALID_PERIOD', log, {
        requestId,
        details: { periodType, received: periodStr },
      })
    }

    try {
      const proposal = await buildVatSettlementProposal(
        supabase, companyId!, periodType, year, period, { fiscalPeriodId },
      )
      return NextResponse.json({ data: proposal })
    } catch (err) {
      log.error('vat settlement proposal failed', err as Error, {
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
