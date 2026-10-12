import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { runLadderCron } from '@/lib/collections/autopilot'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { ensureInitialized } from '@/lib/init'
import { createServiceClient } from '@/lib/supabase/server'

ensureInitialized()

/** One bank check per overdue invoice of every company on the ladder. */
export const maxDuration = 300

/**
 * GET /api/collections/ladder/cron: daily at 06:15 UTC (vercel.json). For
 * each company whose collections connection is active with the ladder set
 * to 'staged' and whose start gates say yes, rejects its own batch left
 * pending for 72 hours and stages today's batch of overdue invoices and
 * waiting case decisions as one pending operation, which an administrator
 * reviews and approves in Att göra. It stages only: nothing reaches a
 * customer from here. A no-op while COLLECTIONS_ENABLED or
 * COLLECTIONS_LADDER_ENABLED is unset.
 */
export const GET = withCronContext('cron.collections_ladder', async (_request, ctx) => {
  try {
    const summary = await runLadderCron({ db: createServiceClient(), log: ctx.log })
    ctx.log.info('collections ladder summary', { ...summary })
    return NextResponse.json({ data: summary })
  } catch (err) {
    ctx.log.error('collections ladder failed', err as Error)
    return errorResponse(err, ctx.log, { requestId: ctx.requestId })
  }
})
