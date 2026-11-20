import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isoDateSchema } from '@/lib/invariants/zod'
import { fxMonthlyRevaluationEnabled } from '@/lib/env/fx-monthly-revaluation-switch'
import {
  MonthlyRevaluationError,
  executeMonthlyCurrencyRevaluation,
} from '@/lib/bookkeeping/currency-revaluation-monthly'
import { ClosingRateUnavailableError } from '@/lib/bookkeeping/currency-revaluation'

const BodySchema = z.object({ month_end: isoDateSchema })

/**
 * POST /api/bookkeeping/currency-revaluation/monthly: revalue the open
 * foreign-currency receivables and payables at a month end inside the
 * financial year and reverse it on the next day (#523). Needs
 * NEXT_PUBLIC_FX_MONTHLY_REVALUATION_ENABLED and the company's own choice
 * (company_settings.fx_revaluation_monthly). Answers the revaluation and its
 * storno, or null data when nothing in foreign currency is open.
 */
export const POST = withRouteContext(
  'bookkeeping.currency-revaluation.monthly',
  async (request, ctx) => {
    const reply = (code: string, details?: Record<string, unknown>) =>
      errorResponseFromCode(code, ctx.log, { requestId: ctx.requestId, details })
    if (!fxMonthlyRevaluationEnabled()) return reply('FX_MONTHLY_REVALUATION_DISABLED')
    const body = await validateBody(request, BodySchema, {
      log: ctx.log,
      operation: 'bookkeeping.currency-revaluation.monthly',
    })
    if (!body.success) return body.response
    const monthEnd = body.data.month_end

    const { data: period, error } = await ctx.supabase
      .from('fiscal_periods')
      .select('id')
      .eq('company_id', ctx.companyId)
      .lte('period_start', monthEnd)
      .gte('period_end', monthEnd)
      .maybeSingle()
    if (error) throw error
    if (!period) return reply('FX_MONTHLY_REVALUATION_NO_PERIOD')

    try {
      const result = await executeMonthlyCurrencyRevaluation(
        ctx.supabase,
        ctx.companyId,
        period.id,
        monthEnd,
        ctx.user.id,
      )
      if (!result) return NextResponse.json({ data: null })
      return NextResponse.json({
        data: {
          journal_entry_id: result.entry.id,
          voucher_series: result.entry.voucher_series ?? null,
          voucher_number: result.entry.voucher_number ?? null,
          reversal_entry_id: result.reversal.id,
          net_effect: result.preview.netEffect,
        },
      })
    } catch (err) {
      if (err instanceof MonthlyRevaluationError) return reply(err.code)
      if (err instanceof ClosingRateUnavailableError) return reply(err.code, { missingRates: err.missingRates })
      throw err
    }
  },
  { requireWrite: true },
)
