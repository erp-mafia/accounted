import type { SupabaseClient } from '@supabase/supabase-js'
import { addDaysIso } from '@/lib/dates/iso'
import { postingPort } from '@/lib/posting/port'
import { linkBasisColumns } from '@/lib/links/stamp'
import { yearEndStornoBusinessEvent } from '@/lib/core/bookkeeping/year-end-business-events'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import type { JournalEntry } from '@/types'
import {
  ClosingRateUnavailableError,
  currencyRevaluationBusinessEvent,
  previewCurrencyRevaluation,
  requireFxExposureScope,
  type CurrencyRevaluationPreviewWithExclusions,
} from './currency-revaluation'

/**
 * Monthly currency revaluation, an option for a company that wants its
 * monthly reports at current rates (deferred in #523 until a K3 customer
 * asked; behind company_settings.fx_revaluation_monthly, default off).
 *
 * At a month end inside the financial year the open foreign-currency
 * receivables and payables are valued at that day's Riksbanken rate, the
 * difference against their original rate is booked to 3960/7960 exactly as
 * the balansdagen revaluation does, and the verifikat is reversed on the
 * first day of the next month (storno through the posting port). The
 * revaluation is always measured from the original rate, so each month
 * stands alone, the ledger never carries two months at once, and the
 * balansdagen revaluation of the year-end close is unaffected: it counts only
 * posted revaluations, and a reversed one is not.
 *
 * The balansdag itself is refused here: the year-end close values it and
 * keeps it (ÅRL 4 kap. 13 §).
 */

export class MonthlyRevaluationError extends Error {
  constructor(
    readonly code:
      | 'FX_MONTHLY_REVALUATION_NOT_ENABLED'
      | 'FX_MONTHLY_REVALUATION_DATE_INVALID'
      | 'FX_MONTHLY_REVALUATION_EXISTS',
    message: string,
  ) {
    super(message)
    this.name = 'MonthlyRevaluationError'
  }
}

export interface MonthlyRevaluationResult {
  entry: JournalEntry
  reversal: JournalEntry
  preview: CurrencyRevaluationPreviewWithExclusions
}

/** Whether `iso` is the last day of its month. */
export function isMonthEnd(iso: string): boolean {
  return addDaysIso(iso, 1).slice(8, 10) === '01'
}

/** A month end strictly inside [periodStart, periodEnd): the balansdag belongs to the year-end close. */
export function assertMonthEndInsidePeriod(monthEnd: string, periodStart: string, periodEnd: string): void {
  if (!isMonthEnd(monthEnd) || monthEnd < periodStart || monthEnd >= periodEnd) {
    throw new MonthlyRevaluationError(
      'FX_MONTHLY_REVALUATION_DATE_INVALID',
      `${monthEnd} är inte ett månadsskifte före räkenskapsårets slut (${periodEnd})`,
    )
  }
}

export async function executeMonthlyCurrencyRevaluation(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  monthEnd: string,
  userId: string,
): Promise<MonthlyRevaluationResult | null> {
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('fx_revaluation_monthly')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) throw new BookkeepingDatabaseError('check_existing_revaluation', settingsError.message)
  if (!settings?.fx_revaluation_monthly) {
    throw new MonthlyRevaluationError('FX_MONTHLY_REVALUATION_NOT_ENABLED', 'Månadsvis valutaomvärdering är inte påslagen')
  }

  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()
  if (periodError || !period) throw new BookkeepingDatabaseError('check_existing_revaluation', periodError?.message ?? 'not found')
  assertMonthEndInsidePeriod(monthEnd, period.period_start, period.period_end)

  // One revaluation per month end, reversed or not.
  const { count, error: existingError } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('source_type', 'currency_revaluation')
    .eq('entry_date', monthEnd)
    .in('status', ['posted', 'reversed'])
  if (existingError) throw new BookkeepingDatabaseError('check_existing_revaluation', existingError.message)
  if ((count ?? 0) > 0) {
    throw new MonthlyRevaluationError('FX_MONTHLY_REVALUATION_EXISTS', `Valutaomvärdering per ${monthEnd} finns redan`)
  }

  const scope = await requireFxExposureScope(supabase, companyId)
  const preview = await previewCurrencyRevaluation(supabase, companyId, monthEnd, { scope })
  if (preview.missingClosingRates.length > 0) throw new ClosingRateUnavailableError(preview.missingClosingRates)
  if (preview.items.length === 0 || preview.lines.length === 0) return null

  const entry = await postingPort.postJournalEntry({
    supabase,
    companyId,
    userId,
    event: () => currencyRevaluationBusinessEvent({
      fiscalPeriodId,
      closingDate: monthEnd,
      netEffect: preview.netEffect,
      linkBasis: linkBasisColumns('user_created'),
    }),
    input: {
      fiscal_period_id: fiscalPeriodId,
      entry_date: monthEnd,
      description: `Omvärdering utländsk valuta ${monthEnd} (månadsskifte)`,
      source_type: 'currency_revaluation',
      voucher_series: 'A',
      lines: preview.lines,
    },
  })

  const reversalDate = addDaysIso(monthEnd, 1)
  const reversal = await postingPort.reverseJournalEntry({
    supabase,
    companyId,
    userId,
    entryId: entry.id,
    reversalDate,
    event: () => yearEndStornoBusinessEvent({
      fiscalPeriodId,
      occurredOn: reversalDate,
      linkBasis: linkBasisColumns('user_created'),
    }),
    role: 'reversal',
  })

  return { entry, reversal, preview }
}
