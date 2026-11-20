import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { sendPeppolDailyReport } from '@/lib/invoices/peppol-daily-report'

/** The limit these runs already had as the platform default, now declared: a scheduled route states its own (scripts/generate-crontabs.ts). */
export const maxDuration = 300

/**
 * GET /api/peppol/daily-report/cron: once a day, in the morning.
 *
 * Mails the operators the last 24 hours of Peppol traffic
 * (lib/invoices/peppol-daily-report.ts): the list to check against Qvalia's
 * dashboard while Qvalia reports no delivery status.
 */
export const GET = withCronContext('cron.peppol_daily_report', async (_request, ctx) => {
  const result = await sendPeppolDailyReport(createServiceClientNoCookies())
  if (!result.sent && result.reason === 'send_failed') {
    ctx.log.error('peppol daily report: e-mail failed', new Error(result.detail ?? 'send failed'), { alert: true })
  } else {
    ctx.log.info('peppol daily report', { ...result })
  }
  return NextResponse.json({ data: result })
})

export const POST = GET
