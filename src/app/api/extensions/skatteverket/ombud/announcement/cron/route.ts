import { NextResponse } from 'next/server'
import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { runOmbudAnnouncementCron } from '@/extensions/general/skatteverket/lib/ombud-announcement'

export const maxDuration = 300

/** Sending stops this long after the run started, well inside maxDuration; the rest goes on the next run. */
const SEND_BUDGET_MS = 240_000

/**
 * GET /api/extensions/skatteverket/ombud/announcement/cron, daily at 07:15
 * UTC (vercel.json, the Docker crontab). The one-time mail telling the owners
 * and admins of companies that use the Skatteverket integration that they can
 * now appoint the app as ombud (extensions/general/skatteverket/lib/
 * ombud-announcement.ts). Sends only with
 * SKATTEVERKET_OMBUD_ANNOUNCEMENT_MAILS=true; otherwise a truthful count-only
 * answer: companies due, people, mails, skipped by reason.
 */
export const GET = withServiceCronContext(
  'cron.skatteverket_ombud_announcement',
  async (_request, ctx) => {
    const result = await runOmbudAnnouncementCron(ctx.supabase, ctx.log, { deadline: ctx.startedAt + SEND_BUDGET_MS })
    ctx.log.info('skatteverket ombud announcement summary', result)
    return NextResponse.json(result)
  },
  { requireExtension: 'skatteverket' },
)
