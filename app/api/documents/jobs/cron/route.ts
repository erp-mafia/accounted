import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { enqueueMissingExtractions, runDocumentJobs } from '@/lib/documents/jobs/queue'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/documents/jobs/cron
 * Arkiv phase 3 worker, every minute: queues extract jobs for admitted
 * documents that never had one, then claims due document jobs (read,
 * classify, extract) and runs them. Ticks may overlap; the claim skips
 * locked rows, so no job runs twice. The time budget leaves room for the
 * last job's model calls inside maxDuration.
 */
export const maxDuration = 300

const BATCH = 8
const BACKFILL_LIMIT = 20
const TIME_BUDGET_MS = 180_000

export const GET = withCronContext('documents.jobs', async (_request, ctx) => {
  const supabase = createServiceRoleClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  try {
    const backfilled = await enqueueMissingExtractions(supabase, BACKFILL_LIMIT)
    const summary = await runDocumentJobs(supabase, {
      limit: BATCH,
      worker: `cron:${process.env.VERCEL_DEPLOYMENT_ID ?? 'local'}`,
      budgetMs: TIME_BUDGET_MS,
    })
    ctx.log.info('document jobs', { backfilled, ...summary })
    return NextResponse.json({ ok: true, backfilled, ...summary })
  } catch (err) {
    ctx.log.error('document jobs failed', { reason: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ ok: false, error: getErrorMessage(err) }, { status: 500 })
  }
})
