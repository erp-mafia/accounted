import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { runCollectionsSync } from '@/lib/collections/sync'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'

/** A handover retry may wait 130 s for Connect; the run budget (SYNC_RUN_BUDGET_MS) keeps inside this. */
export const maxDuration = 300

/**
 * GET /api/collections/sync/cron: every ten minutes (vercel.json). Polls
 * the collections connections whose activation is under way, finishes
 * handovers that timed out, and re-reads the cases the change feed names
 * (plus the daily safety net). Not start work: it runs whatever the start
 * gates say, and on an installation with no connection it reads empty pages.
 */
export const GET = withCronContext('cron.collections_sync', async (_request, ctx) => {
  try {
    const summary = await runCollectionsSync({ db: createServiceClient(), startedAtMs: ctx.startedAt })
    ctx.log.info('collections sync summary', { ...summary })
    return NextResponse.json({ data: summary })
  } catch (err) {
    ctx.log.error('collections sync failed', err as Error)
    return errorResponse(err, ctx.log, { requestId: ctx.requestId })
  }
})
