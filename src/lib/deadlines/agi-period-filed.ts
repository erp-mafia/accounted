/**
 * Whether an AGI redovisningsperiod's first declaration is filed. It lives in
 * the deadlines block beside AGI_RECEIPT_STATUSES (agi-filed.ts), below
 * payroll and payments in the module layers (lib/modules/README.md).
 *
 * Filed means Skatteverket's kvittens for the month is on record. The
 * period's declaration carries it (AGI_RECEIPT_STATUSES) until a correction
 * takes the row over; after that agi_kvittenser keeps every kvittens, and the
 * run whose declaration was signed keeps its agi_submitted_at stamp. A
 * declaration awaiting signature is not filed: it is sent in when it is
 * signed.
 *
 * Only a kvittens counts, never an AGI deadline ticked off by hand. The AGI
 * generator reads this to leave every frånvarouppgift out of a rättelse
 * (Kontroller ba_824, lib/salary/agi/xml-generator.ts), and a first
 * declaration left without its frånvarouppgifter can never get them
 * (Teknisk beskrivning 1.1.18.2, 9.3), while a file ba_824 refuses says so at
 * upload. The late-day gate (correctionPeriodFiled, lib/salary/late-days.ts)
 * is broader on purpose: a declaration awaiting signature or a deadline
 * marked done keeps a late day out of a correction. The deadline generator
 * reads the same kvittens and receipt status for whole years at once
 * (fetchFiledAgiPeriods, lib/tax/deadline-generator.ts).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { addMonthsIso, previousMonthEndIso } from '@/lib/dates/iso'
import { AGI_RECEIPT_STATUSES } from './agi-filed'
import { agiReportingPeriod, formatAgiPeriodDashed, type AgiReportingPeriod } from './agi-reporting-period'

/**
 * `declaration`: the period's agi_declarations row as the caller read it, or
 * null. A receipt status on it answers without a query; an unreadable answer
 * is an error, never "not filed".
 */
export async function agiPeriodFiled(
  supabase: SupabaseClient,
  companyId: string,
  period: AgiReportingPeriod,
  declaration: { status: string } | null,
): Promise<{ ok: true; filed: boolean } | { ok: false; error: unknown }> {
  if (declaration && AGI_RECEIPT_STATUSES.includes(declaration.status)) return { ok: true, filed: true }
  // payment_date is NOT NULL, so the payout month is exactly this range
  // (as readOtherRunsPaidInPeriod reads it).
  const monthStart = `${formatAgiPeriodDashed(period)}-01`
  const monthEnd = previousMonthEndIso(addMonthsIso(monthStart, 1))
  const [kvittenser, filedRuns] = await Promise.all([
    supabase
      .from('agi_kvittenser')
      .select('id')
      .eq('company_id', companyId)
      .eq('period_year', period.periodYear)
      .eq('period_month', period.periodMonth)
      .limit(1),
    supabase
      .from('salary_runs')
      .select('period_year, period_month, payment_date')
      .eq('company_id', companyId)
      .gte('payment_date', monthStart)
      .lte('payment_date', monthEnd)
      .not('agi_submitted_at', 'is', null),
  ])
  const error = kvittenser.error ?? filedRuns.error
  if (error) return { ok: false, error }
  const runs = (filedRuns.data ?? []) as Array<{ period_year: number; period_month: number; payment_date: string }>
  const runFiled = runs.some((run) => {
    const runPeriod = agiReportingPeriod(run)
    return runPeriod.periodYear === period.periodYear && runPeriod.periodMonth === period.periodMonth
  })
  return { ok: true, filed: ((kvittenser.data ?? []) as unknown[]).length > 0 || runFiled }
}
