/**
 * A staged operation whose booking date a period lock covers (crm#1923).
 *
 * Approving a proposal that posts a verifikat on a locked date is refused by
 * the lock triggers, and the refusal closes the proposal. The stager is told
 * when it stages, and the person sees it in the approval queue before the
 * click. Both read the lock here.
 *
 * The verdict is read when it is asked for, never stored on the row: a
 * stored "locked" would keep Godkänn disabled after the person unlocks the
 * period, and a stored "open" says nothing once a period is locked while the
 * proposal waits.
 *
 * Only the operation types in POSTING_DATE are judged: those whose approval
 * posts a verifikat on a date the staged row states. A date on any other row
 * (the invoice date of a draft, the period end of a VAT filing, the day of a
 * bank row that is only ignored) is no posting date, and a lock there stops
 * nothing: telling its approver "locked" would block an approval that works.
 * Adding a type means reading its executor in ./commit.ts to the posting.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolvePeriodLocksForDates, type PeriodLockForDate } from '@/lib/core/bookkeeping/period-status'
import { isSaneDateString } from '@/lib/invariants/iso-date'
import { createLogger } from '@/lib/logger'

const log = createLogger('pending-operations/period-lock')

interface StagedOperation {
  operation_type: string
  params?: Record<string, unknown> | null
  preview_data?: Record<string, unknown> | null
}

/** Where each judged operation type states the date its approval posts on. */
const POSTING_DATE: Readonly<Record<string, (op: StagedOperation) => unknown>> = {
  // commitCreateVoucher posts the verifikat on params.entry_date.
  create_voucher: (op) => op.params?.entry_date,
  // categorizeMatchedTransaction books the bank row on the row's own date,
  // which every stager of the type states as preview.date.
  categorize_transaction: (op) => op.preview_data?.date,
}

/**
 * The date approving the operation posts a verifikat on, or null for a type
 * that is not judged or a row without one. A date that does not exist is none:
 * it would fail the period read for every row listed with it.
 */
export function stagedPostingDate(op: StagedOperation): string | null {
  if (!Object.hasOwn(POSTING_DATE, op.operation_type)) return null
  const date = POSTING_DATE[op.operation_type](op)
  return typeof date === 'string' && isSaneDateString(date) ? date : null
}

/**
 * The lock that stops an approval, as the approval queue reads it from
 * preview_data.period_status of a listed row.
 */
export interface StagedPeriodLock {
  period_id: string | null
  status: 'locked' | 'closed'
  /**
   * The company lock date the posting date is on or before ("låst t.o.m.").
   * Null when the fiscal year's own lock or its closing stops the posting.
   */
  lock_date: string | null
  /** The date the approval would post on. */
  date: string
}

/**
 * The lock on `date` as a stop, or null when the date is open. A lock that
 * could not be read is no stop here: nothing is known about the date, and the
 * triggers decide at approval.
 */
export function stagedPeriodLock(date: string, lock: PeriodLockForDate | undefined): StagedPeriodLock | null {
  if (!lock || lock.status.lookup_failed || lock.status.status === 'open') return null
  return {
    period_id: lock.status.period_id,
    status: lock.status.status,
    lock_date: lock.layer === 'company_lock_date' ? lock.status.lock_date : null,
    date,
  }
}

/**
 * What the staging answer tells the stager when the operation's posting date
 * is locked now: that the proposal cannot be approved as it stands, and the
 * two ways on. English, like the staging message it is part of. Null when
 * the type is not judged, `checkedDate` is not its posting date, or the date
 * is open.
 */
export function stagedPeriodLockNote(
  op: StagedOperation,
  checkedDate: string | undefined,
  lock: PeriodLockForDate | undefined,
): string | null {
  const date = stagedPostingDate(op)
  if (!date || date !== checkedDate) return null
  const stop = stagedPeriodLock(date, lock)
  if (!stop) return null
  if (stop.status === 'closed') {
    return `PERIOD CLOSED: ${date} is in a fiscal year closed with a year-end closing, so this proposal cannot be approved as it stands: the approval is refused and nothing is booked. A closed year is not unlocked. Tell the user, and stage the entry again with a date in the open fiscal year.`
  }
  const what = stop.lock_date
    ? `is on or before the company lock date (bookkeeping is locked through ${stop.lock_date})`
    : 'is in a locked fiscal year'
  const unlock = stop.lock_date
    ? 'the user moves the lock date back first (gnubok_update_bookkeeping_lock, or Inställningar > Bokföring in the app)'
    : 'the user unlocks the year first (gnubok_unlock_period, or Inställningar > Räkenskapsår in the app)'
  return `PERIOD LOCKED: ${date} ${what}, so this proposal cannot be approved as it stands: the approval is refused with PERIOD_LOCKED and nothing is booked. Tell the user, then either stage it again with a date in an open period (and reject this one), or ${unlock} and it is approved after that.`
}

/**
 * The listed rows, each judged operation whose posting date is locked now
 * carrying the lock as preview_data.period_status. Two reads for the whole
 * list, none when no row is judged. A failed read lists the rows as stored:
 * the queue then says nothing about locks and the triggers decide.
 */
export async function withPeriodLocks<T extends StagedOperation>(
  supabase: SupabaseClient,
  companyId: string,
  rows: readonly T[],
): Promise<T[]> {
  const dates = rows.map(stagedPostingDate)
  const wanted = dates.filter((date): date is string => date !== null)
  if (wanted.length === 0) return [...rows]
  let locks: Map<string, PeriodLockForDate>
  try {
    locks = await resolvePeriodLocksForDates(supabase, companyId, wanted)
  } catch (err) {
    log.warn('period locks could not be read for the approval queue', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    return [...rows]
  }
  return rows.map((row, index) => {
    const date = dates[index]
    const stop = date ? stagedPeriodLock(date, locks.get(date)) : null
    return stop ? { ...row, preview_data: { ...(row.preview_data ?? {}), period_status: stop } } : row
  })
}
