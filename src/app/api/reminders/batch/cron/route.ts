import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { runReminderBatchCron } from '@/lib/reminders/gather'
import { createServiceClient } from '@/lib/supabase/server'

/** One decision, and for a due reminder one bank check, per overdue invoice of every company with reminders on. */
export const maxDuration = 300

/**
 * GET /api/reminders/batch/cron: daily at 06:45 UTC (vercel.json). For each
 * company with reminders on, withdraws its batch left pending for 72 hours
 * (or of a company that turned reminders off) and stages today's reminders
 * as one pending operation, which an owner or administrator reviews and
 * approves in Att göra. It stages only: nothing reaches a customer from
 * here. A no-op while REMINDERS_SENDING_ENABLED is false.
 */
export const GET = withCronContext('cron.reminder_batch', async (_request, ctx) => {
  try {
    const summary = await runReminderBatchCron({ db: createServiceClient(), log: ctx.log })
    ctx.log.info('reminder batch summary', { ...summary })
    return NextResponse.json({ data: summary })
  } catch (err) {
    ctx.log.error('reminder batch failed', err as Error)
    return errorResponse(err, ctx.log, { requestId: ctx.requestId })
  }
})
