import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { enqueueMissingExtractions, runDocumentJobs } from '@/lib/documents/jobs/queue'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { withAiDeadline } from '@/lib/ai/call-limit'

/**
 * GET /api/documents/jobs/cron
 * Arkiv phase 3 worker, every minute: queues extract jobs for admitted
 * documents that never had one, then claims due document jobs (read,
 * classify, extract) one at a time and runs them. Ticks may overlap; the
 * claim skips locked rows, so no job runs twice.
 */
export const maxDuration = 300

const BATCH = 8
const BACKFILL_LIMIT = 20
/** No job is claimed past this point, counted from when the request arrived; the rest stays queued for the next tick. */
const TIME_BUDGET_MS = 180_000
/**
 * No model call is still open past this point (lib/ai/call-limit.ts), so the
 * last job is settled, failed with the provider's backoff if its call was cut,
 * inside maxDuration instead of being killed mid-step (seen at 242 s of 300 in
 * the 30 days to 2026-11-12, with nothing but the kill to stop it).
 */
const MODEL_STOP_MS = 280_000

export const GET = withCronContext('documents.jobs', async (_request, ctx) => {
  const supabase = createServiceRoleClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  // The top-up is a convenience for one kind of job; the claims are what every upload waits on. In one try with
  // them, a failing top-up stopped every claim, and queued jobs hold their documents out of the backfills, so
  // nothing read or typed anything while it failed. It is reported and the queue runs.
  let backfilled: number | null = null
  let topUpError: unknown = null
  try {
    backfilled = await enqueueMissingExtractions(supabase, BACKFILL_LIMIT)
  } catch (err) {
    topUpError = err
    ctx.log.error('extraction top-up failed, running the queue without it', { reason: err instanceof Error ? err.message : String(err) })
  }
  try {
    const summary = await withAiDeadline(ctx.startedAt + MODEL_STOP_MS, () =>
      runDocumentJobs(supabase, {
        limit: BATCH,
        worker: `cron:${process.env.VERCEL_DEPLOYMENT_ID ?? 'local'}`,
        deadlineAt: ctx.startedAt + TIME_BUDGET_MS,
      }),
    )
    ctx.log.info('document jobs', { backfilled, ...summary })
    // The jobs ran, but the run did not do all of its work: a 200 would say it had.
    if (topUpError) return NextResponse.json({ ok: false, backfilled, ...summary, error: getErrorMessage(topUpError) }, { status: 500 })
    return NextResponse.json({ ok: true, backfilled, ...summary })
  } catch (err) {
    ctx.log.error('document jobs failed', { reason: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ ok: false, error: getErrorMessage(err) }, { status: 500 })
  }
})
