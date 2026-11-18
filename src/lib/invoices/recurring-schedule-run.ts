/**
 * One run of a recurring schedule: the claim, the invoice, its record on the
 * schedule before the send, and what a run that does not finish leaves
 * behind. The hourly cron and "Skapa faktura nu" both run through this, so
 * the two doors that create a recurring invoice record their run the same
 * way (accounted#213): "Skapa faktura nu" recorded its run only after the
 * send, with no claim gate, and a record that failed, or a function killed in
 * between, left the schedule on the period it had just billed for the cron to
 * bill again.
 *
 * What stays with each door is passed in: which schedules it runs, whether
 * the run moves next_run_date on, and what a run given back leaves.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import type { RecurringInvoiceSchedule, RecurringInvoiceScheduleItem } from '@/types'
import {
  executeRecurringSchedule,
  getStockholmDateHour,
  RecurringInvoiceKeptError,
  RecurringRecordNotLandedError,
  type ExecuteResult,
} from '@/lib/invoices/recurring-schedule-service'
import { advancePeriodStart } from '@/lib/invoices/recurring-placeholders'
import {
  claimRecurringScheduleRun,
  heldWarning,
  holdRecurringScheduleRun,
  releaseRecurringScheduleRun,
  scheduleRecordsInvoice,
  writeUnlessRunSince,
} from '@/lib/invoices/recurring-schedule-claim'

/** Shown from the moment an auto-send invoice exists until its send has answered. */
const SEND_NOT_CONFIRMED_WARNING =
  'Fakturan skapades, men utskicket blev inte bekräftat. Kontrollera fakturan och skicka den manuellt om den inte har gått iväg.'

export interface RecurringRunOptions {
  /** The instant of the run: the claim token, and the day the invoice is dated and the warnings name. */
  now: Date
  /** The route-level sandbox flag (ASVS V2.3), passed on to the service. */
  suppressAutoSend: boolean
  /** Written with the record. Absent, the record leaves next_run_date as it is. */
  nextRunDate?: string
  /**
   * The warning a run that is given back leaves: nothing was created, or
   * what was created is confirmed gone. `reason` is the failure.
   */
  givenBackWarning: (reason: string) => string | null
  log: Logger
}

/** Not claimed: another run holds the schedule, and nothing was created. */
export type RecurringRunOutcome = { claimed: false } | { claimed: true; result: ExecuteResult }

/**
 * Claim the run, create the invoice, record it on the schedule before the
 * send, and settle whatever went wrong. Throws once the schedule is settled
 * as far as it can be: the claim write's failure (nothing claimed);
 * RecurringInvoiceKeptError (the invoice is in place, or may be; unless the
 * record landed, the schedule is held for a person); RecurringRecordNotLandedError
 * (its draft is confirmed gone; the run is given back from the hold, when it
 * holds one); anything else (no invoice remains; the run is given back).
 */
export async function runRecurringSchedule(
  supabase: SupabaseClient,
  schedule: RecurringInvoiceSchedule & { items: RecurringInvoiceScheduleItem[] },
  options: RecurringRunOptions,
): Promise<RecurringRunOutcome> {
  const { now, suppressAutoSend, nextRunDate, givenBackWarning, log } = options
  const day = getStockholmDateHour(now).date

  // Atomic claim (claimRecurringScheduleRun): of two runs that read the same
  // last_run_at, two cron invocations, two clicks or a click during the cron,
  // only one flips the row. The claim writes the warning a person reads if
  // this run never finishes: until the record or a release replaces it, a
  // kill at any point leaves the schedule held, never free beside an invoice
  // it may not record.
  const claimTs = now.toISOString()
  if (!(await claimRecurringScheduleRun(supabase, schedule, claimTs, { last_run_warning: heldWarning(day) }))) {
    return { claimed: false }
  }

  const provisionalWarning = schedule.auto_send && !suppressAutoSend ? SEND_NOT_CONFIRMED_WARNING : null
  /** The token the record left on last_run_at once it landed: the schedule is this run's while it stays. */
  let recordedAt: string | null = null

  // Record the invoice on the schedule the moment it exists, before the
  // send, and only while this run holds the claim (last_run_at = claimTs).
  // The record moves last_run_at on to a token of its own: kept at the claim
  // token, a claim taken from that token by a run that read the schedule
  // while this one held it still matched after the record and billed the
  // period a second time (accounted#211). An error answer does not prove the
  // record failed: it may have landed, or still be on its way. So the run is
  // first held, in one UPDATE that moves the claim on to a hold and writes the
  // held warning, only while this run still holds the claim
  // (holdRecurringScheduleRun). Of the record and the hold whichever commits
  // first wins and the other matches nothing:
  // - held: the record can no longer land, so RecurringRecordNotLandedError
  //   tells the service to remove the unnumbered draft; only once that is
  //   confirmed is the run given back (from the hold);
  // - not held, or not known: the schedule is read back. Naming this run's
  //   invoice, it proves the record landed, and the run goes on to the send.
  //   Otherwise (another run's claim, a read that fails) nobody can tell, the
  //   draft is kept and the run ends as RecurringInvoiceKeptError.
  // Every step is a single UPDATE that leaves the schedule held if it is the
  // last one to land: the claim, the hold and the kept warning all carry the
  // held warning, and only a confirmed removal is followed by a release. A
  // record that answers no row lost its claim to another run: it did not land
  // and cannot, and the claim is not this run's to hold.
  const recordInvoice = async (invoiceId: string) => {
    const recordTs = new Date(Math.max(Date.now(), now.getTime() + 1)).toISOString()
    const { data: landed, error: updateError } = await supabase
      .from('recurring_invoice_schedules')
      .update({
        ...(nextRunDate ? { next_run_date: nextRunDate } : {}),
        last_run_at: recordTs,
        last_invoice_id: invoiceId,
        // Until the send answers: if the run dies while sending, this is
        // what the user reads.
        last_run_warning: provisionalWarning,
        generated_count: schedule.generated_count + 1,
        // The invoice just billed this period: point the schedule at the
        // next one. The cron's stale roll deliberately leaves it alone
        // (nothing was billed), so "Skapa faktura nu" still bills the missed
        // period and advances it then. A draft removed before it is issued
        // gives the period back (lib/invoices/recurring-draft-period.ts).
        ...(schedule.period_start
          ? { period_start: advancePeriodStart(schedule.period_start, schedule.interval_months ?? 1) }
          : {}),
      })
      .eq('id', schedule.id)
      .eq('company_id', schedule.company_id)
      .eq('last_run_at', claimTs)
      .select('id')
    if (!updateError && Array.isArray(landed) && landed.length > 0) {
      recordedAt = recordTs
      return
    }
    if (!updateError) {
      throw new RecurringRecordNotLandedError(invoiceId, 'the schedule no longer holds this run: another run claimed it')
    }
    const reason = updateError.message.slice(0, 300).replace(/\.$/, '')
    // A hold distinct from the claim and from the record's token, so the
    // record (gated on the claim) can no longer land once the hold has.
    const holdTs = new Date(Math.max(Date.now(), Date.parse(recordTs) + 1)).toISOString()
    const hold = await holdRecurringScheduleRun(supabase, schedule, claimTs, holdTs, heldWarning(day, reason))
    if (hold === 'held') {
      throw new RecurringRecordNotLandedError(invoiceId, `schedule update failed for invoice ${invoiceId}: ${updateError.message}`, holdTs)
    }
    if (await scheduleRecordsInvoice(supabase, schedule, invoiceId)) {
      log.warn('recurring record answered an error but landed; the run goes on to the send', {
        scheduleId: schedule.id,
        invoiceId,
        hold,
        error: updateError.message,
      })
      recordedAt = recordTs
      return
    }
    throw new Error(`the record of invoice ${invoiceId} on the schedule is not confirmed (${hold}): ${updateError.message}`)
  }

  let result: ExecuteResult
  try {
    result = await executeRecurringSchedule(supabase, schedule, now, {
      suppressAutoSend,
      onInvoiceCreated: recordInvoice,
    })
  } catch (err) {
    // A sentence written for the user (the invoice series refusal) ends in a
    // full stop of its own; the warnings add one.
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 300).replace(/\.$/, '')
    if (err instanceof RecurringInvoiceKeptError) {
      log.error('recurring run failed with its invoice in place, or possibly in place', err, {
        scheduleId: schedule.id,
        invoiceId: err.invoiceId,
        recorded: recordedAt !== null,
      })
      // Recorded: the schedule names the invoice and has moved on; the
      // record's own warning stands (for a send, "check that it went out").
      // Not recorded: the invoice may be there and the schedule does not
      // know it, so the claim (or the hold) stays and the person is told to
      // look. Should this write fail too, the held warning the claim or the
      // hold wrote already says the same. It writes only a hold, never lifts
      // one, so it needs no gate.
      if (recordedAt === null) {
        const { error: warningError } = await supabase
          .from('recurring_invoice_schedules')
          .update({ last_run_warning: heldWarning(day, reason) })
          .eq('id', schedule.id)
          .eq('company_id', schedule.company_id)
        if (warningError) {
          log.error('the kept-invoice warning could not be written; the schedule stays held by its claim', warningError, {
            scheduleId: schedule.id,
          })
        }
      }
      throw err
    }
    if (err instanceof RecurringRecordNotLandedError) {
      // Its draft is confirmed gone. Held (the record's answer was lost): the
      // run is given back from the hold. No hold (another run took the
      // claim): nothing here is this run's.
      if (err.heldAt && !(await releaseRecurringScheduleRun(supabase, schedule, err.heldAt, { last_run_warning: givenBackWarning(reason) }))) {
        log.error('a held recurring run could not be given back; the schedule waits for a person', err, {
          scheduleId: schedule.id,
        })
      }
      throw err
    }
    // Any other failure left no invoice (it came before one was created, or
    // the draft was confirmed removed): the claim is given back. A release
    // that does not land leaves the schedule held by its claim, for a person.
    if (!(await releaseRecurringScheduleRun(supabase, schedule, claimTs, { last_run_warning: givenBackWarning(reason) }))) {
      log.error('a failed recurring run could not give its claim back; the schedule waits for a person', err as Error, {
        scheduleId: schedule.id,
      })
    }
    throw err
  }

  // The send has answered: its warning (or none) replaces the provisional
  // one, skipped when nothing would change. Only while the schedule still
  // holds this run's record: a run that claimed it since (another tab while
  // this one was sending) wrote the held warning a person must read if it
  // dies, and erasing it let the next date bill that run's period again
  // (accounted#213). Should the write fail, the run is still recorded and
  // the provisional warning asks the user to check the invoice.
  if (result.warning !== provisionalWarning && recordedAt !== null) {
    const closing = await writeUnlessRunSince(
      supabase,
      { id: schedule.id, company_id: schedule.company_id, last_run_at: recordedAt },
      { last_run_warning: result.warning },
    )
    if (closing.error) {
      log.error('recurring run recorded but its warning could not be written', new Error(closing.error), {
        scheduleId: schedule.id,
        invoiceId: result.invoiceId,
      })
    } else if (!closing.written) {
      log.info('another run claimed the schedule after this run recorded its invoice; that run\'s warning stands', {
        scheduleId: schedule.id,
        invoiceId: result.invoiceId,
      })
    }
  }

  return { claimed: true, result }
}
