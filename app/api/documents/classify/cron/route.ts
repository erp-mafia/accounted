import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { classifyUnclassifiedDocuments } from '@/lib/documents/classify/classify'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/documents/classify/cron
 * Arkiv phase 2 backfill: classifies documents that have page text but no
 * type yet, for companies in the rollout, a bounded batch per company.
 */
export const maxDuration = 300

const BATCH_PER_COMPANY = 10
const MAX_COMPANIES = 20

export const GET = withCronContext('documents.classify', async (_request, ctx) => {
  const supabase = createServiceRoleClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
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
  const companies = [...new Set(((data ?? []) as Array<{ company_id: string | null }>).map((r) => r.company_id).filter((c): c is string => !!c))]
    .filter((c) => isArkivEnabled(c))
    .slice(0, MAX_COMPANIES)
  const totals = { companies: companies.length, processed: 0, classified: 0, held: 0, skipped: 0, errors: 0 }
  for (const companyId of companies) {
    const c = await classifyUnclassifiedDocuments(supabase, companyId, BATCH_PER_COMPANY)
    totals.processed += c.processed; totals.classified += c.classified; totals.held += c.held; totals.skipped += c.skipped; totals.errors += c.errors
  }
  ctx.log.info('document classify backfill', totals)
  return NextResponse.json({ ok: true, ...totals })
})
