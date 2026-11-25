import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runFortnoxTopups } from '@/extensions/general/arcim-migration/lib/fortnox-topup'

// The nightly top-up from Fortnox, for the companies that turned it on
// (lib/fortnox-topup.ts). It runs twice a night, after the automatic lock
// (01:40), so a lock date moved that night is the plan's to read before a
// voucher is written. The second run takes the companies the first did not
// reach or the platform ended, and finds the others done.
export const maxDuration = 800
// No company is started after ten minutes; one company takes at most five,
// and is cut at the hard stop, before the platform ends the function.
const SWEEP_UNTIL_MS = 600_000
const HARD_STOP_MS = 760_000

export const GET = withCronContext('cron.arcim_migration_fortnox_topup', async (_request, ctx) => {
  const result = await runFortnoxTopups({
    supabase: createServiceClientNoCookies(),
    deadline: ctx.startedAt + SWEEP_UNTIL_MS,
    hardDeadline: ctx.startedAt + HARD_STOP_MS,
  })
  ctx.log.info('fortnox top-up run finished', result)
  return NextResponse.json({ data: result })
}, { requireExtension: 'arcim-migration' })
