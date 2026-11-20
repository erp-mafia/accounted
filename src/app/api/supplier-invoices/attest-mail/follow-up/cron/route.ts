import { NextResponse } from 'next/server'
import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { runAttestFollowUps } from '@/lib/supplier-invoices/attest-mail-run'

export const maxDuration = 300

/**
 * GET /api/supplier-invoices/attest-mail/follow-up/cron, daily at 06:15 UTC
 * (07:15 Stockholm in winter; vercel.json, the Docker crontab). The batched
 * attest mail's follow-up (crm#1569): reminders to the attesters 3 days
 * before the due date and the day before, and the registrant told once when
 * an invoice passes its due date without attest or nobody can attest it
 * (lib/supplier-invoices/attest-mail-run.ts). Answers skipped until the
 * migration has reached the database.
 */
export const GET = withServiceCronContext('cron.attest_mail_follow_ups', async (_request, ctx) => {
  const result = await runAttestFollowUps(ctx.supabase, ctx.log)
  ctx.log.info('attest follow-up summary', { ...result })
  return NextResponse.json(result)
})
