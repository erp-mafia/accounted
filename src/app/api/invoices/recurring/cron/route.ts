import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  executeRecurringSchedule,
  RecurringInvoiceKeptError,
  RecurringRecordNotLandedError,
  computeNextRunDate,
  rollNextRunDateForward,
  getStockholmDateHour,
} from '@/lib/invoices/recurring-schedule-service'
import { advancePeriodStart } from '@/lib/invoices/recurring-placeholders'
import {
  claimRecurringScheduleRun,
  holdRecurringScheduleRun,
  releaseRecurringScheduleRun,
} from '@/lib/invoices/recurring-schedule-claim'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import type {
  RecurringInvoiceSchedule,
  RecurringInvoiceScheduleItem,
} from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { addDaysIso } from '@/lib/dates/iso'

type DueSchedule = RecurringInvoiceSchedule & { items: RecurringInvoiceScheduleItem[] }

/** The limit these runs already had as the platform default, now declared: a scheduled route states its own (scripts/generate-crontabs.ts). */
export const maxDuration = 300

/**
 * GET /api/invoices/recurring/cron: hourly (top of every hour, UTC).
 *
 * Users pick a send hour in Swedish local time (send_hour, 0-23,
 * Europe/Stockholm). This cron runs every hour and, for each active schedule
 * due today, sends only once the chosen Stockholm hour has arrived.
 *
 * Safety rules (see DECISIONS.md):
 *  - Never send for a date in the past. A schedule whose next_run_date is
 *    before today (a missed prior day, e.g. after an outage or on a schedule
 *    the user just reactivated) is rolled forward to its next future
 *    occurrence WITHOUT generating anything.
 *  - Paused schedules are ignored (status filter). Existing schedules were
 *    paused on deploy so nothing resumes sending behind the user's back.
 *
 * Each schedule runs in isolated try/catch so a failure on one doesn't block
 * the rest. Once the invoice exists: bump next_run_date one interval_months
 * step forward (1 = monthly, 3 = quarterly, 6 = half-yearly, 12 = yearly), set
 * last_run_at/last_invoice_id/generated_count and move the period on. This is
 * written before the auto-send, the slow part of a run, so a run killed while
 * sending leaves a schedule that knows its invoice (with a warning to check
 * that it went out) instead of one that reports "Ingen faktura skapades" the
 * next day and bills the same period again. On failure: leave next_run_date
 * alone so a later run retries.
 *
 * Time: schedules are read in a stable order, page by page, and no schedule
 * is claimed RUN_BUDGET_MS into the run: a claim taken just before the
 * function limit (300 s, the platform default; this route sets none) would be
 * killed mid-run. Schedules not reached are due at the next hourly run.
 */
const RUN_BUDGET_MS = 200_000

/** Shown from the moment an auto-send invoice exists until its send has answered. */
const SEND_NOT_CONFIRMED_WARNING =
  'Fakturan skapades, men utskicket blev inte bekräftat. Kontrollera fakturan och skicka den manuellt om den inte har gått iväg.'

/**
 * The last sentence of the warning a run leaves while it may have created an
 * invoice its schedule does not record: written with the claim (a run killed
 * at any point after it keeps it), with the hold of a record whose answer was
 * lost, and on RecurringInvoiceKeptError. Each write that settles the run
 * replaces it: the record, or the release that gives the run back. The stale
 * roll recognises the schedule by it and leaves it for a person: rolling it
 * would write "Ingen faktura skapades" beside a draft that may exist, and,
 * with its period never advanced, the next run would bill the same period
 * again.
 */
const HELD_FOR_A_PERSON =
  'Har schemat inte flyttats till nästa körning väntar det tills du har gjort något av detta.'

/**
 * The two cases a person can tell apart and the cron cannot, each with its
 * own action. No invoice for the period: "Skapa faktura nu" bills it and
 * moves the period on; pausing and activating alone would move the run date
 * on with the period never billed on time. An invoice for it: the schedule's
 * period start must lie after that invoice's period before the schedule runs
 * again, or the next run bills the period a second time; activating lifts
 * the hold. "Skapa faktura nu" and "Aktivera" are the buttons' own labels.
 */
function heldWarning(day: string, reason?: string): string {
  const what = reason ? `Körningen ${day} avbröts: ${reason}.` : `Körningen ${day} avslutades inte.`
  return (
    `${what} Kontrollera om en faktura skapades för perioden. Om ingen skapades: använd "Skapa faktura nu". ` +
    'Om en skapades: se till att schemats periodstart (om den är ifylld) ligger efter fakturans period, ' +
    `och pausa och aktivera sedan schemat. ${HELD_FOR_A_PERSON}`
  )
}

function retryWarning(day: string, reason: string): string {
  return `Körningen ${day} misslyckades: ${reason}. Nytt försök görs automatiskt varje timme idag.`
}

function isHeldForAPerson(warning: string | null | undefined): boolean {
  return typeof warning === 'string' && warning.endsWith(HELD_FOR_A_PERSON)
}

export const GET = withCronContext('cron.recurring_invoices', async (_request, ctx) => {
  const supabase = createServiceClient()

  const now = new Date()
  // "Today" and the current hour in Swedish local time. Date math for rolling
  // next_run_date uses a UTC-midnight Date of the Stockholm calendar day so it
  // stays consistent with the Stockholm day even across the UTC boundary.
  const { date: todayStockholm, hour: currentHour } = getStockholmDateHour(now)
  const stockholmToday = new Date(`${todayStockholm}T00:00:00Z`)

  // Oldest due date first, then id: a stable order, so a run that is cut
  // short leaves the same tail for the next hour instead of an arbitrary one,
  // and page by page, so no schedule is dropped past PostgREST's 1000 rows.
  let schedules: DueSchedule[]
  try {
    schedules = await fetchAllRows<DueSchedule>(({ from, to }) =>
      supabase
        .from('recurring_invoice_schedules')
        .select('*, items:recurring_invoice_schedule_items(*)')
        .eq('status', 'active')
        .lte('next_run_date', todayStockholm)
        .order('next_run_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    )
  } catch (error) {
    ctx.log.error('failed to load due recurring schedules', error as Error)
    return NextResponse.json(
      { success: false, error: getUserErrorMessage(error) },
      { status: 500 },
    )
  }

  const deadline = ctx.startedAt + RUN_BUDGET_MS
  let notReached = 0

  ctx.log.info('recurring invoice cron starting', {
    dueCount: schedules.length,
    todayStockholm,
    currentHour,
  })

  type RunResult = {
    scheduleId: string
    invoiceId?: string
    invoiceNumber?: string | null
    autoSent?: boolean
    warning?: string | null
    skipped?: boolean
    skipReason?: string
    error?: string
  }
  const results: RunResult[] = []

  const summary = await ctx.forEach('schedule', schedules, async (schedule, itemCtx) => {
    // 1. Missed a prior day: never send for the past. Roll forward to the next
    //    future occurrence (this month if the day hasn't passed, else next
    //    month) without generating an invoice. This also protects the
    //    reactivation path: turning a long-paused schedule back on rolls it to
    //    its next date rather than firing a stale one immediately.
    if (schedule.next_run_date < todayStockholm) {
      // A run that did not settle (killed after its claim, or stopped with an
      // invoice its schedule may not record) left it for a person
      // (heldWarning): no roll and no new warning, the one on the recurring
      // invoices page says what to do. Said once as an error, at the
      // schedule's own hour on the day after the missed date; the runs after
      // it pass it by quietly.
      if (isHeldForAPerson(schedule.last_run_warning)) {
        if (addDaysIso(schedule.next_run_date, 1) === todayStockholm && currentHour === schedule.send_hour) {
          itemCtx.log.error(
            'recurring schedule held for a person: its last run did not settle and may have left an invoice the schedule does not record',
            new Error('recurring schedule held after a run that did not settle'),
            { scheduleId: schedule.id, missedDate: schedule.next_run_date, lastInvoiceId: schedule.last_invoice_id },
          )
        }
        results.push({ scheduleId: schedule.id, skipped: true, skipReason: 'held_for_a_person' })
        return
      }
      // Roll on the schedule's own month grid (anchored on the missed date,
      // not on today) so a quarterly/yearly schedule keeps its phase: a
      // Jan 15 quarterly run missed in an outage rolls to Apr 15, not Feb 15.
      const rolledNext = rollNextRunDateForward(
        schedule.next_run_date,
        stockholmToday,
        schedule.day_of_month,
        schedule.interval_months,
        { allowToday: true },
      )
      // Surface the skip on the schedule: a day of failed runs (or a cron
      // outage) would otherwise roll the month forward with no user-visible
      // trace. The next successful run overwrites this, and a conscious
      // reactivation clears it (PATCH route).
      const { error: rollError } = await supabase
        .from('recurring_invoice_schedules')
        .update({
          next_run_date: rolledNext,
          last_run_warning: `Ingen faktura skapades den ${schedule.next_run_date}. Nästa körning: ${rolledNext}. Använd "Skapa faktura nu" om månadens faktura fortfarande behövs.`,
        })
        .eq('id', schedule.id)
        .eq('company_id', schedule.company_id)
      if (rollError) {
        throw new Error(`failed to roll stale schedule forward: ${rollError.message}`)
      }
      itemCtx.log.info('stale schedule rolled forward without sending', {
        from: schedule.next_run_date,
        to: rolledNext,
      })
      results.push({
        scheduleId: schedule.id,
        skipped: true,
        skipReason: 'stale_rolled_forward',
      })
      return
    }

    // 2. Due today but the chosen Stockholm hour hasn't arrived yet. A later
    //    run this same day will pick it up (send_hour <= currentHour).
    if (currentHour < schedule.send_hour) {
      results.push({
        scheduleId: schedule.id,
        skipped: true,
        skipReason: 'hour_not_reached',
      })
      return
    }

    // 3. Idempotency fast-path: skip if the row we loaded already shows a run
    //    today (cheap check against the batch, no write).
    if (schedule.last_run_at) {
      const lastRunDay = getStockholmDateHour(new Date(schedule.last_run_at)).date
      if (lastRunDay >= todayStockholm) {
        itemCtx.log.info('schedule already ran today; skipping')
        results.push({
          scheduleId: schedule.id,
          skipped: true,
          skipReason: 'already_ran_today',
        })
        return
      }
    }

    // Nothing is claimed near the limit: a run killed after its claim cannot
    // give the claim back, and the schedule would wait for a person (its
    // claim says the run did not finish). Not claimed, it is simply due again
    // at the next hourly run.
    if (Date.now() >= deadline) {
      notReached++
      results.push({
        scheduleId: schedule.id,
        skipped: true,
        skipReason: 'time_budget_reached',
      })
      return
    }

    // Defence in depth (ASVS V2.3): the email chokepoint inside the schedule
    // service enforces the sandbox rule on its own; the route additionally
    // resolves it here and passes an explicit suppress flag, so the invariant
    // does not hinge on a single check buried in a library function. The
    // invoice is still generated as a draft (freeze-and-retain). Read before
    // the claim: a failed read leaves nothing claimed, so the next hourly run
    // retries instead of finding the schedule held.
    const suppressAutoSend = schedule.auto_send
      ? await isSandboxCompany(supabase, schedule.company_id)
      : false

    // 4. Atomic claim. Two hourly cron invocations can overlap (an hour-boundary
    //    retry, or a manual re-trigger) and both read the same stale
    //    last_run_at from the batch above, so the read-only check in step 3
    //    can't by itself stop a double-send. Compare-and-set last_run_at from
    //    the exact value we read to `now`: Postgres row-locking serialises the
    //    two writers, so only the one whose WHERE still matches the old value
    //    flips the row and gets it back; the loser matches zero rows and skips.
    //    Cheaper than a Postgres advisory lock, and it closes the window for the
    //    whole batch execution, not just a single row.
    //    "Skapa faktura nu" claims through the same function.
    //    The claim writes the warning a person reads if this run never
    //    finishes (heldWarning): until the record or a release replaces it, a
    //    kill at any point leaves the schedule held, never free beside an
    //    invoice it may not record.
    const claimTs = now.toISOString()
    if (!(await claimRecurringScheduleRun(supabase, schedule, claimTs, { last_run_warning: heldWarning(todayStockholm) }))) {
      itemCtx.log.info('schedule claimed by a concurrent cron run; skipping')
      results.push({
        scheduleId: schedule.id,
        skipped: true,
        skipReason: 'claimed_by_concurrent_run',
      })
      return
    }

    // 5. Spawn the invoice. If it throws after we claimed, release the claim
    //    (restore the prior last_run_at) so a later cron retries today rather
    //    than treating the row as already run, and persist the failure as a
    //    user-visible warning: a deterministic error (bad VAT rate, missing
    //    items) fails every hourly retry and would otherwise skip the month
    //    silently via the stale roll-forward above. A later successful run
    //    overwrites the warning.

    // 6. Record the invoice on the schedule the moment it exists, before the
    //    send, and only while this run holds the claim (last_run_at =
    //    claimTs). An error answer does not prove the record failed: it may
    //    have landed, or still be on its way. So the run is first held, in
    //    one UPDATE that moves the claim on to a hold and writes the held
    //    warning, only while the schedule still has the run date and period
    //    this run read (holdRecurringScheduleRun). Of the record and the hold
    //    whichever commits first wins and the other matches nothing:
    //    - held: the record can no longer land, so RecurringRecordNotLandedError
    //      tells the service to remove the unnumbered draft; only once that is
    //      confirmed is the run given back (step 5's release, from the hold);
    //    - not held, or not known: the record landed (or nobody can tell), so
    //      the draft is kept and the run ends as RecurringInvoiceKeptError.
    //    Every step is a single UPDATE that leaves the schedule held if it is
    //    the last one to land: the claim, the hold and the kept warning all
    //    carry the held warning, and only a confirmed removal is followed by a
    //    release. A record that answers no row lost its claim to another run:
    //    it did not land and cannot, and the claim is not this run's to hold.
    const recordInvoice = async (invoiceId: string) => {
      const nextRunDate = computeNextRunDate(
        stockholmToday,
        schedule.day_of_month,
        schedule.interval_months,
      )
      const { data: recorded, error: updateError } = await supabase
        .from('recurring_invoice_schedules')
        .update({
          next_run_date: nextRunDate,
          last_run_at: claimTs,
          last_invoice_id: invoiceId,
          // Until the send answers (step 7 overwrites it): if the run dies
          // while sending, this is what the user reads.
          last_run_warning: schedule.auto_send && !suppressAutoSend ? SEND_NOT_CONFIRMED_WARNING : null,
          generated_count: schedule.generated_count + 1,
          // The invoice just billed this period: point the schedule at the
          // next one. A stale roll-forward above deliberately leaves it alone
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
      if (!updateError && Array.isArray(recorded) && recorded.length > 0) return
      if (!updateError) {
        throw new RecurringRecordNotLandedError(invoiceId, 'the schedule no longer holds this run: another run claimed it')
      }
      const reason = updateError.message.slice(0, 300).replace(/\.$/, '')
      // A hold distinct from the claim, so the record (gated on the claim)
      // can no longer land once the hold has.
      const holdTs = new Date(Math.max(Date.now(), now.getTime() + 1)).toISOString()
      const hold = await holdRecurringScheduleRun(
        supabase,
        schedule,
        claimTs,
        holdTs,
        { next_run_date: schedule.next_run_date, period_start: schedule.period_start ?? null },
        heldWarning(todayStockholm, reason),
      )
      if (hold === 'held') {
        throw new RecurringRecordNotLandedError(invoiceId, `schedule update failed for invoice ${invoiceId}: ${updateError.message}`, holdTs)
      }
      throw new Error(`the record of invoice ${invoiceId} on the schedule is not confirmed (${hold}): ${updateError.message}`)
    }

    let result: Awaited<ReturnType<typeof executeRecurringSchedule>>
    try {
      result = await executeRecurringSchedule(supabase, schedule, now, {
        suppressAutoSend,
        onInvoiceCreated: recordInvoice,
      })
    } catch (err) {
      // A sentence written for the user (the invoice series refusal) ends in a
      // full stop of its own; the template adds one.
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 300).replace(/\.$/, '')
      if (err instanceof RecurringInvoiceKeptError) {
        // The invoice is in place (recorded on the schedule, or kept because
        // nobody could tell): there is no retry today, so the claim (or the
        // hold) stays and the user is told to look at the invoice. Should
        // this write fail too, the held warning the claim or the hold wrote
        // already says the same.
        itemCtx.log.error('recurring run failed with its invoice in place', err, {
          scheduleId: schedule.id,
          invoiceId: err.invoiceId,
        })
        const { error: warningError } = await supabase
          .from('recurring_invoice_schedules')
          .update({ last_run_warning: heldWarning(todayStockholm, reason) })
          .eq('id', schedule.id)
          .eq('company_id', schedule.company_id)
        if (warningError) {
          itemCtx.log.error('the kept-invoice warning could not be written; the schedule stays held by its claim', warningError, {
            scheduleId: schedule.id,
          })
        }
        throw err
      }
      if (err instanceof RecurringRecordNotLandedError) {
        // Its draft is confirmed gone. Held (the record's answer was lost):
        // the run is given back from the hold, and the hour after retries. No
        // hold (another run took the claim): nothing here is this run's.
        if (err.heldAt && !(await releaseRecurringScheduleRun(supabase, schedule, err.heldAt, { last_run_warning: retryWarning(todayStockholm, reason) }))) {
          itemCtx.log.error('a held recurring run could not be given back; the schedule waits for a person', err, {
            scheduleId: schedule.id,
          })
        }
        throw err
      }
      // Any other failure happened before the invoice was recorded: the
      // claim is given back and the hour after retries. A release that does
      // not land leaves the schedule held by its claim, for a person.
      if (!(await releaseRecurringScheduleRun(supabase, schedule, claimTs, { last_run_warning: retryWarning(todayStockholm, reason) }))) {
        itemCtx.log.error('a failed recurring run could not give its claim back; the schedule waits for a person', err as Error, {
          scheduleId: schedule.id,
        })
      }
      throw err
    }

    // 7. The send has answered: its warning (or none) replaces the
    //    provisional one. Skipped when nothing would change.
    const provisionalWarning = schedule.auto_send && !suppressAutoSend ? SEND_NOT_CONFIRMED_WARNING : null
    if (result.warning !== provisionalWarning) {
      const { error: warningError } = await supabase
        .from('recurring_invoice_schedules')
        .update({ last_run_warning: result.warning })
        .eq('id', schedule.id)
        .eq('company_id', schedule.company_id)
      if (warningError) {
        // The run itself is recorded; only its closing note is not. The
        // provisional warning stays, which asks the user to check the invoice.
        itemCtx.log.error('recurring run recorded but its warning could not be written', warningError, {
          scheduleId: schedule.id,
          invoiceId: result.invoiceId,
        })
      }
    }

    results.push({
      scheduleId: schedule.id,
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber,
      autoSent: result.autoSent,
      warning: result.warning,
    })
  })

  if (notReached > 0) {
    ctx.log.error(
      'recurring invoice run stopped at its time budget; the schedules left are due at the next hourly run',
      new Error('recurring invoice run out of time'),
      { notReached, dueCount: schedules.length },
    )
  }

  ctx.log.info('recurring invoice cron summary', {
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
    notReached,
  })

  return NextResponse.json({
    success: true,
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
    not_reached: notReached,
    failures: summary.failures,
    results,
  })
})

export const POST = GET
