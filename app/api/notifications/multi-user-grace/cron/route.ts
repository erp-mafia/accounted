import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClient } from '@/lib/supabase/server'
import { runMultiUserGraceReminders } from '@/lib/notifications/multi-user-grace'

ensureInitialized()

/**
 * GET /api/notifications/multi-user-grace/cron, daily 07:00 UTC.
 *
 * Mails company owners when the multi_user grace window opens (their extra
 * members will pause in 20 days) and again on its last day. Windowed on the
 * grant expiry timestamps so a once-daily run sends each mail exactly once;
 * see lib/notifications/multi-user-grace.ts.
 */
export const GET = withCronContext('cron.multi_user_grace', async (_request, ctx) => {
  const supabase = createServiceClient()
  const summary = await runMultiUserGraceReminders(supabase, new Date())

  ctx.log.info('multi-user grace reminder summary', { ...summary })

  return NextResponse.json({ success: true, ...summary })
})

export const POST = GET

/** A grants scan plus a handful of emails. */
export const maxDuration = 300
