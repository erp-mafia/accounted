/**
 * Resolving a measure's dimension against the company's books: which fiscal
 * period, which dates, which momsperiod. Every rule here refuses with a typed
 * MeasureRefusal and a Swedish sentence rather than guessing: a parameter the
 * measure does not take, a period that does not exist and a range outside its
 * fiscal year all stop before any figure is read.
 *
 * The validators are the reports' own: parseReportDateRange (the resultat-
 * and balansrapport ranges) and parseLedgerAsOfDate (the reskontra balance
 * date), so a measure accepts exactly what its report accepts.
 */
import { todayIsoStockholm } from '@/lib/dates/iso'
import { parseReportDateRange } from '@/lib/reports/date-range'
import { parseLedgerAsOfDate } from '@/lib/reports/ledger-as-of'
import {
  DIMENSION_PARAMS,
  MEASURE_PARAM_KEYS,
  MeasureRefusal,
  type MeasureContext,
  type MeasureDefinition,
  type MeasureFiscalPeriod,
  type MeasureParams,
  type ResolvedScope,
} from './types'

/** The fiscal period that contains `date`, or null. Throws on a failed read. */
export async function fiscalPeriodContaining(
  ctx: MeasureContext,
  date: string,
): Promise<MeasureFiscalPeriod | null> {
  // Overlapping periods are prevented by an exclusion constraint; limit(1)
  // is defensive.
  const { data, error } = await ctx.supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end')
    .eq('company_id', ctx.companyId)
    .lte('period_start', date)
    .gte('period_end', date)
    .order('period_start', { ascending: false })
    .limit(1)
  if (error) throw Object.assign(new Error(`fiscal period lookup failed: ${error.message}`), { code: error.code })
  const rows = (data ?? []) as MeasureFiscalPeriod[]
  return rows[0] ?? null
}

/** The fiscal period that contains `date`; refuses when none does. */
export async function requireFiscalPeriodContaining(
  ctx: MeasureContext,
  date: string,
): Promise<MeasureFiscalPeriod> {
  const period = await fiscalPeriodContaining(ctx, date)
  if (!period) {
    throw new MeasureRefusal(
      'MEASURE_PERIOD_NOT_FOUND',
      `Inget räkenskapsår i bokföringen omfattar ${date}. Ange ett datum inom ett räkenskapsår, eller period_id för det räkenskapsår som avses.`,
      { date },
    )
  }
  return period
}

async function fiscalPeriodById(ctx: MeasureContext, periodId: string): Promise<MeasureFiscalPeriod> {
  const { data, error } = await ctx.supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end')
    .eq('id', periodId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error) throw Object.assign(new Error(`fiscal period read failed: ${error.message}`), { code: error.code })
  if (!data) {
    throw new MeasureRefusal(
      'MEASURE_PERIOD_NOT_FOUND',
      'Räkenskapsåret finns inte i bolagets bokföring. Hämta giltiga period_id med räkenskapsårslistan.',
      { period_id: periodId },
    )
  }
  return data as MeasureFiscalPeriod
}

/**
 * Refuses a parameter the measure's dimension does not take. Ignoring it
 * would answer another question than the one asked: as_of_date on a period
 * figure, or a date range on a balance.
 */
export function assertAcceptedParams(measure: MeasureDefinition, params: MeasureParams): void {
  const accepted = DIMENSION_PARAMS[measure.dimension]
  const sent = MEASURE_PARAM_KEYS.filter((key) => params[key] !== undefined)
  const refused = sent.filter((key) => !accepted.includes(key))
  if (refused.length > 0) {
    throw new MeasureRefusal(
      'MEASURE_PARAMETER_NOT_ACCEPTED',
      `${measure.name_sv} tar inte ${refused.join(', ')}. Giltiga parametrar: ${accepted.join(', ')}.`,
      { measure_id: measure.id, refused, accepted: [...accepted] },
    )
  }
}

/**
 * The dimension the measure is measured over, resolved and validated.
 * `today` is the Stockholm calendar date (injectable for tests).
 */
export async function resolveScope(
  ctx: MeasureContext,
  measure: MeasureDefinition,
  params: MeasureParams,
  today: string = todayIsoStockholm(),
): Promise<ResolvedScope> {
  assertAcceptedParams(measure, params)

  if (measure.dimension === 'period') {
    const fiscalPeriod = params.period_id
      ? await fiscalPeriodById(ctx, params.period_id)
      : await requireFiscalPeriodContaining(ctx, params.from_date ?? params.to_date ?? today)
    const query = new URLSearchParams()
    if (params.from_date !== undefined) query.set('from_date', params.from_date)
    if (params.to_date !== undefined) query.set('to_date', params.to_date)
    const range = parseReportDateRange(query, fiscalPeriod)
    if (!range.ok) {
      throw new MeasureRefusal('MEASURE_RANGE_INVALID', range.error, {
        period_start: fiscalPeriod.period_start,
        period_end: fiscalPeriod.period_end,
      })
    }
    return {
      kind: 'period',
      fiscalPeriod,
      fromDate: range.range.fromDate,
      toDate: range.range.toDate,
      start: range.range.fromDate ?? fiscalPeriod.period_start,
      end: range.range.toDate ?? fiscalPeriod.period_end,
    }
  }

  if (measure.dimension === 'as_of') {
    const parsed = parseLedgerAsOfDate(params.as_of_date)
    if (!parsed.ok) {
      throw new MeasureRefusal('MEASURE_RANGE_INVALID', `as_of_date: ${parsed.messageSv}`, { field: 'as_of_date' })
    }
    const asOf = parsed.asOfDate ?? today
    // Today is the live state the screens show: the ledgers then read the
    // stored open-invoice state and age it against now, exactly as with no
    // date at all.
    return { kind: 'as_of', asOf, live: asOf === today }
  }

  const { period_type: periodType, year, period } = params
  if (periodType === undefined || year === undefined || period === undefined) {
    throw new MeasureRefusal(
      'MEASURE_PERIOD_REQUIRED',
      `${measure.name_sv} gäller en momsperiod: ange period_type (monthly, quarterly eller yearly), year och period.`,
      { measure_id: measure.id, required: ['period_type', 'year', 'period'] },
    )
  }
  const maxPeriod = periodType === 'monthly' ? 12 : periodType === 'quarterly' ? 4 : 1
  if (!Number.isInteger(period) || period < 1 || period > maxPeriod) {
    throw new MeasureRefusal(
      'MEASURE_RANGE_INVALID',
      `period måste vara 1-${maxPeriod} för ${periodType}.`,
      { field: 'period', max: maxPeriod },
    )
  }
  if (params.period_id !== undefined && periodType !== 'yearly') {
    throw new MeasureRefusal(
      'MEASURE_PARAMETER_NOT_ACCEPTED',
      'period_id gäller bara helårsmoms (period_type yearly): månads- och kvartalsmoms följer kalendern.',
      { measure_id: measure.id, refused: ['period_id'] },
    )
  }
  if (params.period_id !== undefined) await fiscalPeriodById(ctx, params.period_id)
  return { kind: 'vat_period', periodType, year, period, fiscalPeriodId: params.period_id }
}

/** The parameters that pin a resolved scope, for the explain handle: the same figure on a later call. */
export function scopeParams(scope: ResolvedScope): MeasureParams {
  switch (scope.kind) {
    case 'period':
      return {
        period_id: scope.fiscalPeriod.id,
        ...(scope.fromDate !== undefined ? { from_date: scope.fromDate } : {}),
        ...(scope.toDate !== undefined ? { to_date: scope.toDate } : {}),
      }
    case 'as_of':
      return { as_of_date: scope.asOf }
    case 'vat_period':
      return {
        period_type: scope.periodType,
        year: scope.year,
        period: scope.period,
        ...(scope.fiscalPeriodId !== undefined ? { period_id: scope.fiscalPeriodId } : {}),
      }
  }
}
