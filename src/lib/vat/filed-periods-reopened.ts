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

export interface ReopenedVatPeriod {
  tax_period: string
  period_start: string
  period_end: string
  filed_on: string
}

/**
 * Filed periods with a date that is locked today (on or before `before`) and
 * would be open after the move (after `after`, or everywhere when the lock is
 * removed). Empty when nothing is locked today or the lock moves forward.
 * Each record carries the range it declares (a helårsmoms record spans its
 * räkenskapsår), so every cadence is judged by the same two comparisons.
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
  for (const { tax_period, period_start, period_end, filed_on } of filings) {
    const lockedToday = period_start <= before
    const openAfter = after === null || period_end > after
    if (lockedToday && openAfter) {
      reopened.push({ tax_period, period_start, period_end, filed_on })
    }
  }
  return reopened.sort((a, b) => a.period_start.localeCompare(b.period_start))
}
