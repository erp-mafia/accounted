import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { runCollectionsSync } from '@/lib/collections/sync'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { ensureInitialized } from '@/lib/init'
import { createServiceClient } from '@/lib/supabase/server'

// The sync run grows into case updates that emit events (build spec 1.6).
ensureInitialized()

export const maxDuration = 120

/**
 * GET /api/collections/sync/cron: every ten minutes (vercel.json). Polls
 * the collections connections whose activation is under way and stores what
 * the provider says. Not start work: it runs whatever the start gates say,
 * and on an installation with no connection it reads one empty page.
 */
export const GET = withCronContext('cron.collections_sync', async (_request, ctx) => {
  try {
    const summary = await runCollectionsSync({ db: createServiceClient() })
    ctx.log.info('collections sync summary', { ...summary })
    return NextResponse.json({ data: summary })
  } catch (err) {
    ctx.log.error('collections sync failed', err as Error)
    return errorResponse(err, ctx.log, { requestId: ctx.requestId })
  }
})
