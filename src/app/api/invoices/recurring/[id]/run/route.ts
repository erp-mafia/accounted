import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  computeNextRunDate,
  getStockholmDateHour,
  RecurringInvoiceKeptError,
  RecurringRecordNotLandedError,
} from '@/lib/invoices/recurring-schedule-service'
import { runRecurringSchedule } from '@/lib/invoices/recurring-schedule-run'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import type { RecurringInvoiceSchedule, RecurringInvoiceScheduleItem } from '@/types'

/**
 * POST /api/invoices/recurring/[id]/run: manually generate (and, when the
 * schedule has auto_send, email) an invoice from a recurring schedule right
 * now, on demand.
 *
 * Why this exists: the cron never sends for a past date, and all schedules
 * were paused on the send-time rollout, so a user who wants this month's
 * invoice sent now needs an explicit, conscious action. This is that action.
 * It runs regardless of status (active or paused): the user is clicking the
 * button themselves, so awareness is not in question.
 *
 * It makes the run the hourly cron makes (runRecurringSchedule): the same
 * claim, so a second click from another tab, or the cron reaching the
 * schedule meanwhile, gets 409 RECURRING_RUN_IN_PROGRESS instead of a second
 * invoice (accounted#58); the same record on the schedule before the send,
 * gated on its claim, and the same hold for a run that did not finish
 * (accounted#213). The period moves on with the record.
 *
 * next_run_date moves only when this run is the one that was due: on or
 * after the schedule's run date (a run the cron skipped, held for a person,
 * or has not reached yet today). Left behind, the cron's stale roll said
 * "Ingen faktura skapades" beside this invoice, and a person who acted on it
 * billed the next period early. It moves one interval past the date this run
 * replaces, the cron's own rule, and no further: a later date that has passed
 * too is the stale roll's to report ("Ingen faktura skapades den ..."), not
 * skipped unseen (accounted#213). A click ahead of the date is out of band
 * and leaves the cadence alone.
 */
export const POST = withRouteContext(
  'recurring_invoice.run_now',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    const { data: schedule, error } = await supabase
      .from('recurring_invoice_schedules')
      .select('*, items:recurring_invoice_schedule_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error || !schedule) {
      log.warn('recurring schedule not found for run-now', { scheduleId: id })
      return NextResponse.json(
        { error: 'Schedule not found', type: 'not_found' },
        { status: 404 },
      )
    }

    const typed = schedule as RecurringInvoiceSchedule & {
      items: RecurringInvoiceScheduleItem[]
    }

    // Defence in depth (ASVS V2.3): mirror the cron route. The sandbox rule
    // is enforced inside the service's email chokepoint too; resolving it at
    // the route level as well means the invariant survives refactors of the
    // service internals. Invoice creation is unaffected (freeze-and-retain).
    const suppressAutoSend = typed.auto_send
      ? await isSandboxCompany(supabase, companyId)
      : false

    const now = new Date()
    const today = getStockholmDateHour(now).date
    let outcome: Awaited<ReturnType<typeof runRecurringSchedule>>
    try {
      outcome = await runRecurringSchedule(supabase, typed, {
        now,
        suppressAutoSend,
        // The run that was due is this one: the next is one interval past it,
        // as the cron's own record moves it.
        nextRunDate:
          typed.next_run_date <= today
            ? computeNextRunDate(new Date(`${typed.next_run_date}T00:00:00Z`), typed.day_of_month, typed.interval_months ?? 1)
            : undefined,
        // Given back, the schedule says what it said before the click.
        givenBackWarning: () => typed.last_run_warning ?? null,
        log,
      })
    } catch (err) {
      if (err instanceof RecurringInvoiceKeptError) {
        // The invoice is in place, or may be: a second click could make
        // another for the same period. The schedule says what to check, and
        // the run has logged the failure with the invoice id.
        return errorResponseFromCode('RECURRING_RUN_INVOICE_KEPT', log, { requestId })
      }
      if (err instanceof RecurringRecordNotLandedError && !err.heldAt) {
        // Another run (another tab, the hourly cron) claimed the schedule
        // while this one created its invoice, and this run's draft is
        // confirmed gone: the other run bills the period. "Try again" would
        // bill the next one early (accounted#213).
        log.info('run-now lost its claim to a concurrent run while creating its invoice', { scheduleId: id })
        return errorResponseFromCode('RECURRING_RUN_IN_PROGRESS', log, { requestId })
      }
      log.error('run-now failed to generate invoice', err as Error, { scheduleId: id })
      return errorResponse(err, log, { requestId })
    }
    if (!outcome.claimed) {
      log.info('run-now lost the claim to a concurrent run', { scheduleId: id })
      return errorResponseFromCode('RECURRING_RUN_IN_PROGRESS', log, { requestId })
    }

    const { result } = outcome
    return NextResponse.json({
      data: {
        invoiceId: result.invoiceId,
        invoiceNumber: result.invoiceNumber,
        autoSent: result.autoSent,
        warning: result.warning,
      },
    })
  },
  { requireWrite: true },
)
