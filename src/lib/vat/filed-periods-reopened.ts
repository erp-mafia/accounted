/**
 * Which filed momsdeklaration periods a move of the company-wide lock date
 * would reopen for writes.
 *
 * Moving bookkeeping_locked_through back is legitimate (correcting an error
 * found after filing, voluntarily and before Skatteverket finds it, so no
 * skattetillägg), but it is an accountant's decision: the API asks the caller
 * to acknowledge the filed periods by name. A closed fiscal year needs no such
 * check: it stays closed by its own flag whatever the lock date says.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { listVatFilings } from './filing-record-store'
import type { VatFilingRecord } from './filing-record'

export interface ReopenedVatPeriod {
  tax_period: string
  period_start: string
  period_end: string
  filed_on: string
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function lastDayOfMonth(year: number, month: number): string {
  return `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`
}

/** The calendar range a filing record declares. */
export function vatPeriodRange(record: Pick<VatFilingRecord, 'period_type' | 'year' | 'period'>): {
  period_start: string
  period_end: string
} {
  if (record.period_type === 'quarterly') {
    const firstMonth = (record.period - 1) * 3 + 1
    return {
      period_start: `${record.year}-${pad(firstMonth)}-01`,
      period_end: lastDayOfMonth(record.year, firstMonth + 2),
    }
  }
  return {
    period_start: `${record.year}-${pad(record.period)}-01`,
    period_end: lastDayOfMonth(record.year, record.period),
  }
}

/**
 * Filed periods with a date that is locked today (on or before `before`) and
 * would be open after the move (after `after`, or everywhere when the lock is
 * removed). Empty when nothing is locked today or the lock moves forward.
 */
export async function filedVatPeriodsReopenedBy(
  supabase: SupabaseClient,
  companyId: string,
  before: string | null,
  after: string | null,
): Promise<ReopenedVatPeriod[]> {
  if (before === null) return []
  if (after !== null && after >= before) return []
  const filings = await listVatFilings(supabase, companyId)
  const reopened: ReopenedVatPeriod[] = []
  for (const filing of filings) {
    const { period_start, period_end } = vatPeriodRange(filing)
    const lockedToday = period_start <= before
    const openAfter = after === null || period_end > after
    if (lockedToday && openAfter) {
      reopened.push({ tax_period: filing.tax_period, period_start, period_end, filed_on: filing.filed_on })
    }
  }
  return reopened.sort((a, b) => a.period_start.localeCompare(b.period_start))
}
