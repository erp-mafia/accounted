import { NextResponse } from 'next/server'
import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { runUnendedConsentCron } from '@/lib/bank-feed/unended-consents'

export const maxDuration = 300

/**
 * GET /api/bank/open-payments/unended-consents/cron, daily at 04:05 UTC
 * (vercel.json, the Docker crontab). Asks once more to end the consents of
 * removed Open Payments connections the bank did not end at the time, and
 * clears each one ended or already gone from its row
 * (lib/bank-feed/unended-consents.ts): a consent nobody ends is billed until
 * it expires and holds the company's one bank connection. Without a
 * connector key it answers skipped, with the reason.
 */
export const GET = withServiceCronContext('cron.open_payments_unended_consents', async (_request, ctx) => {
  const result = await runUnendedConsentCron(ctx.supabase, ctx.log)
  if (result.skipped) ctx.log.info('open payments unended consents skipped: no connector key', result)
  else ctx.log.info('open payments unended consents summary', result)
  return NextResponse.json(result)
})
