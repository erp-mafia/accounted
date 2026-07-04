import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClient } from '@/lib/supabase/server'
import {
  executeRecurringSchedule,
  computeNextRunDate,
} from '@/lib/invoices/recurring-schedule-service'
import type {
  RecurringInvoiceSchedule,
  RecurringInvoiceScheduleItem,
} from '@/types'

ensureInitialized()

type DueSchedule = RecurringInvoiceSchedule & { items: RecurringInvoiceScheduleItem[] }

/**
 * GET /api/invoices/recurring/cron: daily 06:30 UTC.
 *
 * Spawns invoices for every active schedule whose next_run_date is today or
 * earlier. Each schedule runs in isolated try/catch so a failure on one
 * doesn't block the rest. On success: bump next_run_date, last_run_at,
 * last_invoice_id, generated_count. On failure: leave next_run_date alone so
 * tomorrow's run retries; pause the schedule only if the same error recurs
 * across days (out of scope for v1: let the user investigate).
 */
export const GET = withCronContext('cron.recurring_invoices', async (_request, ctx) => {
  const supabase = createServiceClient()

  const today = new Date()
  const todayIso = today.toISOString().slice(0, 10)

  const { data: due, error } = await supabase
    .from('recurring_invoice_schedules')
    .select('*, items:recurring_invoice_schedule_items(*)')
    .eq('status', 'active')
    .lte('next_run_date', todayIso)

  if (error) {
    ctx.log.error('failed to load due recurring schedules', error)
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 },
    )
  }

  const schedules = (due ?? []) as DueSchedule[]

  ctx.log.info('recurring invoice cron starting', {
    dueCount: schedules.length,
    todayIso,
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
    // Idempotency: skip if already ran today. Protects against cron retries
    // within the same UTC day; cheaper than a Postgres advisory lock and the
    // window we're protecting (one row, ~seconds) is tiny.
    if (schedule.last_run_at) {
      const lastRunDay = schedule.last_run_at.slice(0, 10)
      if (lastRunDay >= todayIso) {
        itemCtx.log.info('schedule already ran today; skipping')
        results.push({
          scheduleId: schedule.id,
          skipped: true,
          skipReason: 'already_ran_today',
        })
        return
      }
    }

    const result = await executeRecurringSchedule(supabase, schedule, today)

    const nextRunDate = computeNextRunDate(today, schedule.day_of_month)
    const { error: updateError } = await supabase
      .from('recurring_invoice_schedules')
      .update({
        next_run_date: nextRunDate,
        last_run_at: today.toISOString(),
        last_invoice_id: result.invoiceId,
        last_run_warning: result.warning,
        generated_count: schedule.generated_count + 1,
      })
      .eq('id', schedule.id)
      .eq('company_id', schedule.company_id)

    if (updateError) {
      // The invoice exists. If we don't mark the schedule as ran, tomorrow's
      // cron would spawn a duplicate. Surface this loudly.
      itemCtx.log.error(
        'invoice created but failed to update schedule: manual cleanup may be needed',
        updateError,
        { scheduleId: schedule.id, invoiceId: result.invoiceId },
      )
      throw new Error(
        `schedule update failed after invoice ${result.invoiceId} created: ${updateError.message}`,
      )
    }

    results.push({
      scheduleId: schedule.id,
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber,
      autoSent: result.autoSent,
      warning: result.warning,
    })
  })

  ctx.log.info('recurring invoice cron summary', {
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
  })

  return NextResponse.json({
    success: true,
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
    failures: summary.failures,
    results,
  })
})

export const POST = GET
