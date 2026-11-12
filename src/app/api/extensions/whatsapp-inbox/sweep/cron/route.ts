import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runSweep } from '@/extensions/general/whatsapp-inbox/lib/sweep'
import { withAiDeadline } from '@/lib/ai/call-limit'

/**
 * GET /api/extensions/whatsapp-inbox/sweep/cron: per-minute crash recovery
 * for the WhatsApp channel. Re-claims stuck message rows, sends combined
 * acks whose deferred worker died, expires 48h questions and 8h company
 * pins. Scheduled in vercel.json (and the generated Docker crontabs).
 *
 * Overlap with a slow previous run is safe: every mutation is a guarded
 * claim (processing_status / pending_ack), so two sweeps never double-run
 * one row.
 */

// A re-claimed batch can include Bedrock extractions (10-60s each).
export const maxDuration = 300

/**
 * No message, ack or drain is started past this point, counted from when the
 * request arrived. What a message may still need before the model is asked
 * (mark read 10 s, media lookup 10 s, download 30 s) fits between here and
 * MODEL_STOP_MS.
 */
const TIME_BUDGET_MS = 200_000
/**
 * No model call is still open past this point (lib/ai/call-limit.ts): a
 * reading has 250 s of its own, more than a message started late has left.
 * Cut here it counts as the provider being unavailable, which the inbox reads
 * again later, and the 30 s after it are for recording the outcome inside
 * maxDuration.
 */
const MODEL_STOP_MS = 270_000

export const GET = withCronContext('cron.whatsapp_sweep', async (_request, ctx) => {
  const supabase = createServiceClientNoCookies()
  const summary = await withAiDeadline(ctx.startedAt + MODEL_STOP_MS, () =>
    runSweep(supabase, { deadlineAt: ctx.startedAt + TIME_BUDGET_MS }),
  )

  ctx.log.info('whatsapp sweep complete', { ...summary })

  // A pass that could not read its work is a run that did not do its job: the
  // channel's crash recovery is not running, and a 200 would say it is.
  if (summary.failedPasses.length > 0) {
    return NextResponse.json(
      {
        data: summary,
        error: { code: 'SWEEP_PASS_FAILED', message: `WhatsApp sweep: ${summary.failedPasses.join(', ')} failed` },
      },
      { status: 500 },
    )
  }

  return NextResponse.json({ data: summary })
}, { requireExtension: 'whatsapp-inbox' })
