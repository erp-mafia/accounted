import { NextResponse } from 'next/server'
import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { runOpenPaymentsCron } from '@/lib/bank-feed/cron'

export const maxDuration = 300

/**
 * GET /api/bank/open-payments/sync/cron, hourly at :20 (vercel.json, the
 * Docker crontab). Removes abandoned consent attempts, expires consents that
 * have run out, and syncs the Open Payments connections that are due (every
 * 11 hours, four at a time, within a 230 s budget). A truthful no-op without
 * a connector key.
 */
export const GET = withServiceCronContext('cron.open_payments_bank_sync', async (_request, ctx) => {
  const result = await runOpenPaymentsCron(ctx.supabase, ctx.log)
  ctx.log.info('open payments bank sync summary', result)
  return NextResponse.json(result)
})
