import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateQuery } from '@/lib/api/validate'
import { VoucherSequenceNextQuerySchema } from '@/lib/api/schemas'
import { resolveDefaultSeriesForSource } from '@/lib/bookkeeping/voucher-series-resolver'
import { resolveCashAccountVoucherSeries } from '@/lib/bookkeeping/cash-account-voucher-series'

export const GET = withRouteContext(
  'voucher_sequence.next',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const query = validateQuery(request, VoucherSequenceNextQuerySchema, {
      log,
      operation: 'voucher_sequence.next',
    })
    if (!query.success) return query.response
    const {
      period_id: overridePeriodId,
      series: overrideSeries,
      source_type: sourceType,
      cash_account_id: cashAccountId,
    } = query.data

    const today = new Date().toISOString().split('T')[0]
    // Vouchers are numbered per fiscal period, so the preview must reflect the
    // period of the entry's date (e.g. a back-dated payment), not today's.
    const date = query.data.date || today

    const [{ data: period, error: periodError }, { data: settings, error: settingsError }] =
      await Promise.all([
        overridePeriodId
          ? supabase
              .from('fiscal_periods')
              .select('id')
              .eq('company_id', companyId)
              .eq('id', overridePeriodId)
              .maybeSingle()
          : supabase
              .from('fiscal_periods')
              .select('id')
              .eq('company_id', companyId)
              .lte('period_start', date)
              .gte('period_end', date)
              .maybeSingle(),
        overrideSeries
          ? Promise.resolve({ data: null, error: null })
          : supabase
              .from('company_settings')
              .select('default_voucher_series, default_voucher_series_per_source_type')
              .eq('company_id', companyId)
              .maybeSingle(),
      ])

    if (periodError) {
      log.error('fiscal_periods lookup failed', periodError)
      return errorResponse(periodError, log, { requestId })
    }
    if (settingsError) {
      log.error('company_settings lookup failed', settingsError)
      return errorResponse(settingsError, log, { requestId })
    }

    // When a source_type is supplied, resolve the series exactly as the booking
    // engine does (cash account override → per-source-type map → 'A'), so the
    // preview can never disagree with the verifikat that actually gets created.
    // Without a source_type, keep the legacy generic default for callers that
    // just want "the next number".
    // The account override only applies to entries booked from bank
    // transactions; for any other source type it must not colour the preview.
    const cashAccountSeries =
      !overrideSeries && cashAccountId && sourceType === 'bank_transaction'
        ? await resolveCashAccountVoucherSeries(supabase, companyId, cashAccountId)
        : undefined
    const series = overrideSeries
      ? overrideSeries
      : cashAccountSeries
        ? cashAccountSeries
        : sourceType
          ? resolveDefaultSeriesForSource(settings, sourceType)
          : settings?.default_voucher_series || 'A'

    if (!period) {
      return NextResponse.json({ data: { next: null, series, fiscal_period_id: null } })
    }

    const { data: sequence, error: sequenceError } = await supabase
      .from('voucher_sequences')
      .select('last_number')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', period.id)
      .eq('voucher_series', series)
      .maybeSingle()

    if (sequenceError) {
      log.error('voucher_sequences lookup failed', sequenceError)
      return errorResponse(sequenceError, log, { requestId })
    }

    const next = (sequence?.last_number ?? 0) + 1

    return NextResponse.json({
      data: { next, series, fiscal_period_id: period.id },
    })
  },
)
