import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { classifyUnclassifiedDocuments } from '@/lib/documents/classify/classify'
import { requeueStaleVerdicts } from '@/lib/documents/classify/stale'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/documents/classify/cron
 * Arkiv phase 2 backfill: classifies documents that have page text but no
 * type yet, for companies in the rollout, a bounded batch per company. Then
 * re-queues model verdicts the current rules might change (rules.ts), a
 * bounded batch per run, so a classifier fix reaches old verdicts too
 * (2026-09-27: it never did, and six supplier invoices sat under Arcim's
 * Kundfakturor for a week).
 */
export const maxDuration = 300

const BATCH_PER_COMPANY = 10
const MAX_COMPANIES = 20
/**
 * No document is started past this point. A classification is one model call,
 * a few seconds normally and ~15 s in a Bedrock 503 burst (the SDK's own
 * retries), so twenty companies of ten documents could take ten minutes and
 * Vercel killed the run at 300 s (17 times in the week to 2026-10-26). What is
 * left stays untyped, and the next run five minutes later takes it.
 */
const TIME_BUDGET_MS = 200_000
/** What the budget counts per document: the 503 burst's ~15 s with room to spare. */
const PER_DOCUMENT_MS = 20_000
/** Every 5 minutes: at most 7 200 re-runs a day while a rule change drains, one cheap model call each. */
const STALE_PER_RUN = 25

export const GET = withCronContext('documents.classify', async (_request, ctx) => {
  const supabase = createServiceRoleClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  // The shelf is on for everyone: the companies with untyped, read documents are found from the newest such rows.
  const { data, error } = await supabase
    .from('document_attachments')
    .select('company_id')
    .is('doc_type', null)
    .not('pages_read_at', 'is', null)
    .gt('page_count', 0)
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) {
    ctx.log.error('classify backfill fetch failed', { reason: error.message })
    return NextResponse.json({ ok: false, error: getErrorMessage(error) }, { status: 500 })
  }
  const companies = [...new Set(((data ?? []) as Array<{ company_id: string | null }>).map((r) => r.company_id).filter((c): c is string => !!c))].slice(0, MAX_COMPANIES)
  const totals = { companies: companies.length, processed: 0, classified: 0, held: 0, skipped: 0, errors: 0, deferredCompanies: 0 }
  const deadline = Date.now() + TIME_BUDGET_MS
  for (const [index, companyId] of companies.entries()) {
    // A company gets the documents the budget still pays for, so its batch ends inside the budget too.
    const affordable = Math.floor((deadline - Date.now()) / PER_DOCUMENT_MS)
    if (affordable < 1) {
      totals.deferredCompanies = companies.length - index
      break
    }
    const c = await classifyUnclassifiedDocuments(supabase, companyId, Math.min(BATCH_PER_COMPANY, affordable))
    totals.processed += c.processed; totals.classified += c.classified; totals.held += c.held; totals.skipped += c.skipped; totals.errors += c.errors
  }
  let stale = { candidates: 0, queued: 0, skipped: 0 }
  try {
    stale = await requeueStaleVerdicts(supabase, STALE_PER_RUN)
  } catch (err) {
    ctx.log.error('stale verdicts requeue failed', { reason: err instanceof Error ? err.message : String(err) })
  }
  ctx.log.info('document classify backfill', { ...totals, stale })
  return NextResponse.json({ ok: true, ...totals, stale })
})
