import { NextResponse } from 'next/server'
import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { runAttestRequestRound } from '@/lib/supplier-invoices/attest-mail-run'

export const maxDuration = 300

/**
 * GET /api/supplier-invoices/attest-mail/cron, every 5 minutes (vercel.json,
 * the Docker crontab). The batched attest request (crm#1569): for every
 * company that has registered nothing new for 15 minutes, each attester gets
 * one mail listing every queued invoice waiting on them; an invoice nobody
 * can attest is told to its registrant (lib/supplier-invoices/attest-mail-run.ts).
 * Answers skipped until the migration has reached the database.
 */
export const GET = withServiceCronContext('cron.attest_mail_requests', async (_request, ctx) => {
  const result = await runAttestRequestRound(ctx.supabase, ctx.log)
  ctx.log.info('attest request round summary', { ...result })
  return NextResponse.json(result)
})
