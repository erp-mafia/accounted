import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClient } from '@/lib/supabase/server'
import { getAiStatus } from '@/lib/ai'
import { planAssistantReads, readTransaction, storeRead } from '@/lib/agent/categorize/read'

ensureInitialized()

const PER_RUN = Number(process.env.ASSISTANT_READS_PER_RUN ?? 25)
const PER_COMPANY = Number(process.env.ASSISTANT_READS_PER_COMPANY ?? 8)
const WINDOW_DAYS = Number(process.env.ASSISTANT_READS_WINDOW_DAYS ?? 45)
/** Background reads take two samples: the row's opener can always ask for a fuller one. */
const SAMPLES = Number(process.env.ASSISTANT_READS_SAMPLES ?? 2)

/**
 * GET /api/agent/categorize/cron, every ten minutes.
 *
 * Reads the newest unbooked transactions that have no fresh read yet, so
 * the transactions list and the review open with the assistant's pick
 * already there. Writes nothing to the journal: a read is a stored
 * proposal, the booking is still the person's click (or, for a sure read
 * with a receipt behind it, the row's Bokför).
 *
 * `ASSISTANT_READS_MODE=off` is the kill switch; an installation without
 * an AI backend skips quietly.
 */
export const GET = withCronContext('cron.assistant_reads', async (_request, ctx) => {
  if (process.env.ASSISTANT_READS_MODE === 'off') {
    return NextResponse.json({ success: true, skipped: true, reason: 'ASSISTANT_READS_MODE=off', planned: 0 })
  }
  if (!getAiStatus().configured) {
    return NextResponse.json({ success: true, skipped: true, reason: 'ai_unconfigured', planned: 0 })
  }

  const supabase = createServiceClient()
  const plan = await planAssistantReads(supabase, { perRun: PER_RUN, perCompany: PER_COMPANY, windowDays: WINDOW_DAYS })
  ctx.log.info('assistant reads planned', { planned: plan.length })

  const summary = await ctx.forEach('transaction', plan, async (item, itemCtx) => {
    const { read } = await readTransaction(supabase, item.companyId, item.tx, {
      entityType: item.entityType,
      vatRegistered: item.vatRegistered,
      samples: SAMPLES,
    })
    await storeRead(supabase, item.companyId, read)
    itemCtx.log.info('assistant read stored', {
      companyId: item.companyId,
      transactionId: item.tx.id,
      account: read.account,
      confidence: read.confidence,
      hasUnderlag: read.has_underlag,
    })
  })

  return NextResponse.json({
    success: true,
    planned: plan.length,
    succeeded: summary.succeeded,
    failed: summary.failed,
  })
})
