/**
 * The filed momsdeklaration a date lies in.
 *
 * Filing freezes nothing (./filed-period-changes.ts): while the period is
 * open, a verifikat dated inside a filed period still posts, and the
 * declaration Skatteverket holds then differs from the books until a
 * corrected one is filed. A door that books on a date asks here before it
 * books, so the person or the agent is told while the date can still be
 * changed. What they do about it is their call.
 *
 * A record declares its own range (a helårsmoms record spans its
 * räkenskapsår), so the record holding the date answers for every cadence.
 * Where two records hold one date (a period marked by hand under two
 * cadences), the one filed last answers: it is the newest declaration on
 * record for that day.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VatFilingRecord } from './filing-record'
import { listVatFilings } from './filing-record-store'

/** What a warning names about a filed period. */
export interface FiledVatPeriod {
  /** `deadlines.tax_period`: `YYYY-MM`, `YYYY-QN`, or the yearly label. */
  tax_period: string
  period_start: string
  period_end: string
  /** Swedish calendar date the declaration was filed, `YYYY-MM-DD`. */
  filed_on: string
}

type FilingRange = Pick<VatFilingRecord, 'tax_period' | 'period_start' | 'period_end' | 'filed_on'>

/** The filed period holding `date` (`YYYY-MM-DD`), or null when none does. */
export function filedVatPeriodOfDate(filings: readonly FilingRange[], date: string): FiledVatPeriod | null {
  let found: FilingRange | null = null
  for (const filing of filings) {
    if (date < filing.period_start || date > filing.period_end) continue
    if (!found || filing.filed_on > found.filed_on) found = filing
  }
  return found
    ? {
        tax_period: found.tax_period,
        period_start: found.period_start,
        period_end: found.period_end,
        filed_on: found.filed_on,
      }
    : null
}

/**
 * The filed period of each date that lies in one, in one read of the filing
 * record. A date outside every filed period has no entry. Throws when the
 * record cannot be read: the caller decides whether that stops its door.
 */
export async function filedVatPeriodsOfDates(
  supabase: SupabaseClient,
  companyId: string,
  dates: readonly string[],
): Promise<Map<string, FiledVatPeriod>> {
  const found = new Map<string, FiledVatPeriod>()
  const wanted = [...new Set(dates)].filter((date) => !!date)
  if (wanted.length === 0) return found
  const filings = await listVatFilings(supabase, companyId)
  for (const date of wanted) {
    const period = filedVatPeriodOfDate(filings, date)
    if (period) found.set(date, period)
  }
  return found
}

/**
 * The distinct filed periods a set of dates lies in, earliest period first:
 * what a door that writes on several dates names to its user.
 */
export function distinctFiledVatPeriods(found: ReadonlyMap<string, FiledVatPeriod>): FiledVatPeriod[] {
  const byPeriod = new Map<string, FiledVatPeriod>()
  for (const period of found.values()) {
    if (!byPeriod.has(period.tax_period)) byPeriod.set(period.tax_period, period)
  }
  return [...byPeriod.values()].sort((a, b) => a.period_start.localeCompare(b.period_start))
}
