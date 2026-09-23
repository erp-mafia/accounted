import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { readUnreadDocuments } from '@/lib/documents/read/store'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'
import { isArkivEnabled } from '@/lib/arkiv/flag'

/**
 * GET /api/documents/read/cron
 * Arkiv backfill: reads documents that have no page text yet, the rollout
 * companies' first and each by its history lane (phase 9f), a bounded batch
 * per run. Every outcome stamps pages_read_at, so the batch never revisits a
 * row. The time budget leaves room for the last document's model pages inside
 * maxDuration. Authenticated by CRON_SECRET (withCronContext).
 */
export const maxDuration = 300

const BATCH = 40
const TIME_BUDGET_MS = 180_000

/** Vision pages per company and day the backfill may spend on voucher-tied history; 0 (the default) means those pages wait for a question. */
export function backfillPagesPerDay(): number {
  const n = Number(process.env.ARKIV_BACKFILL_PAGES_PER_DAY ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export const GET = withCronContext('documents.read', async (_request, ctx) => {
  const supabase = createServiceRoleClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const counts = await readUnreadDocuments(supabase, BATCH, {
    budgetMs: TIME_BUDGET_MS,
    budgetPagesPerDay: backfillPagesPerDay(),
    // A document read here for the first time gets typed by the pipeline, inside the rollout, like one that arrived today.
    onRead: async (doc) => {
      if (!doc.company_id || doc.doc_type || !isArkivEnabled(doc.company_id)) return
      try {
        await enqueueDocumentJob(supabase, doc.company_id, doc.id, 'classify')
      } catch (err) {
        ctx.log.warn('classify not queued after backfill read', { doc: doc.id, reason: err instanceof Error ? err.message : String(err) })
      }
    },
  })
  ctx.log.info('document read backfill', counts)
  return NextResponse.json({ ok: true, ...counts })
})
