import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClient } from '@/lib/supabase/server'
import { runBookkeepingDigest } from '@/lib/notifications/bookkeeping-digest'

ensureInitialized()

/**
 * GET /api/notifications/bookkeeping-digest/cron, daily 05:45 UTC.
 *
 * Emails opted-in users a "nytt att bokföra" summary: bank transactions and
 * inbox documents that arrived in the last 24 hours. Runs after the 05:00
 * bank sync so the night's imports are in the counts. Strictly opt-in via
 * notification_settings.email_digest_enabled (default false); with nobody
 * opted in the run is a single cheap query.
 */
export const GET = withCronContext('cron.bookkeeping_digest', async (_request, ctx) => {
  const supabase = createServiceClient()
  const summary = await runBookkeepingDigest(supabase, new Date())

  ctx.log.info('bookkeeping digest summary', { ...summary })

  return NextResponse.json({ success: true, ...summary })
})

export const POST = GET

/** Sequential per-company counting plus a handful of emails. */
export const maxDuration = 300
