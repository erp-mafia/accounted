import { NextResponse } from 'next/server'
import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { runBankSwitchReminderCron } from '@/lib/bank-feed/switch-notifications'

export const maxDuration = 300

/**
 * GET /api/bank/open-payments/switch-reminders/cron, daily at 06:30 UTC
 * (07:30 Stockholm in winter; vercel.json, the Docker crontab). Where every
 * admitted company stands in the Enable Banking to Open Payments switch, and
 * when OPENPAYMENTS_SWITCH_DEADLINE and OPENPAYMENTS_SWITCH_MAILS=true are
 * both set, the announcement once per pending company and the reminders at
 * 14, 7, 3 and 1 days (lib/bank-feed/switch-notifications.ts). A truthful
 * count-only answer while the campaign is off or the mails are not.
 */
export const GET = withServiceCronContext('cron.open_payments_switch_reminders', async (_request, ctx) => {
  const result = await runBankSwitchReminderCron(ctx.supabase, ctx.log)
  ctx.log.info('bank switch reminders summary', result)
  return NextResponse.json(result)
})
