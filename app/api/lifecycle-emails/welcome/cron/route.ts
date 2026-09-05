import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { ensureInitialized } from '@/lib/init'
import { runWelcomeEmailSweep } from '@/lib/lifecycle-emails/welcome'

// Module-level: the email extension registers the Resend service when
// extensions load. Without this the no-op service answers "not configured"
// and the sweep sends nothing, silently.
ensureInitialized()

/**
 * GET /api/lifecycle-emails/welcome/cron, every 2 minutes.
 *
 * Sends the welcome email to accounts confirmed since the last tick. All the
 * logic (eligibility, claim, send, release) lives in
 * lib/lifecycle-emails/welcome.ts so it can be unit tested without a route.
 */
export const GET = withCronContext('cron.welcome_email', async (_request, ctx) => {
  const summary = await runWelcomeEmailSweep(createServiceClient(), { log: ctx.log })
  ctx.log.info('welcome email sweep summary', summary)
  return NextResponse.json({ success: true, ...summary })
})
