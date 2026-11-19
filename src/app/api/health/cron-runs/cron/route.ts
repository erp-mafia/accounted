import { NextResponse } from 'next/server'
import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { watchCronRuns } from '@/lib/cron/watch'

/** One pass is a handful of reads and at most one mail (20 s at the e-mail service). */
export const maxDuration = 60

/**
 * GET /api/health/cron-runs/cron: every 10 minutes.
 *
 * The watch over every other scheduled job (lib/cron/watch.ts): closes runs
 * the platform killed at their time limit, records jobs the schedule did not
 * call, copies in failed runs of the database's own scheduler, and mails the
 * team one digest of what nobody has been told about yet. Authenticated by
 * CRON_SECRET (withServiceCronContext).
 *
 * Safe to run twice: every write is conditional on the state it read, and a
 * problem is claimed before it is reported.
 */
export const GET = withServiceCronContext('cron.watch', async (_request, ctx) => {
  const result = await watchCronRuns(ctx.supabase, ctx.log)
  ctx.log.info('cron watch done', { ...result })
  return NextResponse.json({ data: result })
})
