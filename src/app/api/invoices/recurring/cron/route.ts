import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  computeNextRunDate,
  rollNextRunDateForward,
  getStockholmDateHour,
} from '@/lib/invoices/recurring-schedule-service'
import { runRecurringSchedule } from '@/lib/invoices/recurring-schedule-run'
import { isHeldForAPerson, writeUnlessRunSince } from '@/lib/invoices/recurring-schedule-claim'
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

/** What a failed run given back leaves: the hour after retries it. */
function retryWarning(day: string, reason: string): string {
  return `Körningen ${day} misslyckades: ${reason}. Nytt försök görs automatiskt varje timme idag.`
}

/** How many days after its missed date a held schedule is still said as an error. */
const HELD_REPORT_DAYS = 7

/**
 * Whether this run says a held schedule as an error: once a day for the week
 * after its missed date, by the run in the hour (UTC) of the claim or hold its
 * last run left. Every day has that hour, where the schedule's Stockholm send
 * hour is missing on the spring DST day; and a run that is missed, or stops
 * before it reaches the schedule, costs one day's line, not the only one.
 */
function heldReportDue(
  schedule: Pick<RecurringInvoiceSchedule, 'last_run_at' | 'next_run_date'>,
  now: Date,
  today: string,
): boolean {
  if (today > addDaysIso(schedule.next_run_date, HELD_REPORT_DAYS)) return false
  const hour = schedule.last_run_at ? new Date(schedule.last_run_at).getUTCHours() : 0
  return now.getUTCHours() === hour
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
      // invoices page says what to do. Said as an error once a day for a week
      // (heldReportDue); the other runs pass it by quietly. The kill itself
      // is reported within minutes by the cron watch (lib/cron/watch.ts);
      // this line names the schedule it left waiting.
      if (isHeldForAPerson(schedule.last_run_warning)) {
        if (heldReportDue(schedule, now, todayStockholm)) {
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
      // reactivation clears it (PATCH route). Written only while the schedule
      // is as this run read it: a "Skapa faktura nu" that claimed or recorded
      // it since billed the missed run, and "Ingen faktura skapades" over its
      // record would invite a second click that bills the next period early
      // (accounted#213). Its own record already moved the run date on.
      const roll = await writeUnlessRunSince(supabase, schedule, {
        next_run_date: rolledNext,
        last_run_warning: `Ingen faktura skapades den ${schedule.next_run_date}. Nästa körning: ${rolledNext}. Använd "Skapa faktura nu" om månadens faktura fortfarande behövs.`,
      })
      if (roll.error) {
        throw new Error(`failed to roll stale schedule forward: ${roll.error}`)
      }
      if (!roll.written) {
        itemCtx.log.info('stale schedule not rolled: a run claimed or recorded it after this run read it')
        results.push({ scheduleId: schedule.id, skipped: true, skipReason: 'claimed_by_concurrent_run' })
        return
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

    // A run of "Skapa faktura nu" on an earlier day that did not settle left
    // the schedule for a person, as a cron run's does from the day after
    // (step 1): run now, it would bill the period beside an invoice that run
    // may have made (accounted#213). From tomorrow step 1 says it.
    if (isHeldForAPerson(schedule.last_run_warning)) {
      results.push({ scheduleId: schedule.id, skipped: true, skipReason: 'held_for_a_person' })
      return
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

    // 4. The run itself (lib/invoices/recurring-schedule-run.ts), the one
    //    "Skapa faktura nu" makes too: an atomic claim on last_run_at, so two
    //    overlapping cron invocations, or a click during this run, never both
    //    create an invoice (the read-only check in step 3 cannot stop that on
    //    its own); the invoice; its record on the schedule before the send,
    //    gated on the claim; and a run that did not finish left for a person.
    //    The record moves next_run_date one interval on. A failure that left
    //    no invoice gives the claim back with the retry warning, so the hour
    //    after retries today: a deterministic error (bad VAT rate, missing
    //    items) fails every retry and the stale roll then says no invoice was
    //    created. A later successful run overwrites the warning.
    const outcome = await runRecurringSchedule(supabase, schedule, {
      now,
      suppressAutoSend,
      nextRunDate: computeNextRunDate(stockholmToday, schedule.day_of_month, schedule.interval_months),
      givenBackWarning: (reason) => retryWarning(todayStockholm, reason),
      log: itemCtx.log,
    })
    if (!outcome.claimed) {
      itemCtx.log.info('schedule claimed by a concurrent run; skipping')
      results.push({
        scheduleId: schedule.id,
        skipped: true,
        skipReason: 'claimed_by_concurrent_run',
      })
      return
    }

    const { result } = outcome
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
