import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { runReminderBatchCron } from '@/lib/reminders/gather'
import { createServiceClient } from '@/lib/supabase/server'

/** One decision, and for a due reminder one bank check, per overdue invoice of every company with reminders on. */
export const maxDuration = 300

/**
 * No company and no automatic reminder is started this long into the run.
 * What is in flight then (one company's reading of its overdue invoices, or
 * one reminder with its bank check and its mail) has the rest of maxDuration
 * to finish in.
 */
const RUN_BUDGET_MS = 200_000

/**
 * GET /api/reminders/batch/cron: daily at 06:45 UTC (vercel.json). For each
 * company with reminders on, withdraws its batch left pending for 72 hours
 * (or of a company that turned reminders off) and stages today's reminders
 * as one pending operation, which an owner or administrator reviews and
 * approves in Att göra. A no-op while REMINDERS_SENDING_ENABLED is false.
 *
 * This run does send to customers: for a company that has turned automatic
 * sending on, the reminders whose bank check passed go out from here, by
 * mail, without approval (lib/reminders/automatic.ts). Everything else is
 * staged and reaches nobody until a person approves it.
 *
 * The run works inside RUN_BUDGET_MS and starts at a different company each
 * day, so when it is cut short the companies left are not the same ones
 * every time; the count is in the summary and logged as an error.
 */
export const GET = withCronContext('cron.reminder_batch', async (_request, ctx) => {
  try {
    const summary = await runReminderBatchCron({
      db: createServiceClient(),
      log: ctx.log,
      deadline: ctx.startedAt + RUN_BUDGET_MS,
    })
    ctx.log.info('reminder batch summary', { ...summary })
    return NextResponse.json({ data: summary })
  } catch (err) {
    ctx.log.error('reminder batch failed', err as Error)
    return errorResponse(err, ctx.log, { requestId: ctx.requestId })
  }
})
