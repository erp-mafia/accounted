import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { observeObligations } from '@/lib/arkiv/agreements/observe'
import { needsRederivation } from '@/lib/arkiv/agreements/store'
import { todayIso } from '@/lib/arkiv/agreements/dates'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/arkiv/derive/cron
 * Arkiv phase 4, daily: compares every company's expected payments with its
 * bank transactions (matched, missed; observation only), and queues a fresh
 * derivation for agreements older than a week so the schedule keeps rolling
 * a year ahead.
 */
export const maxDuration = 300

const MAX_COMPANIES = 50
const REDERIVE_LIMIT = 100

interface AgreementRow {
  company_id: string
  source_document_id: string
  derived_at: string
}

export const GET = withCronContext('arkiv.derive', async (_request, ctx) => {
  const supabase = createServiceRoleClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const today = todayIso()
  try {
    const { data, error } = await supabase.from('agreements').select('company_id, source_document_id, derived_at').order('derived_at', { ascending: true }).limit(2000)
    if (error) throw new Error(`agreements fetch failed: ${error.message}`)
    const agreements = ((data ?? []) as AgreementRow[]).filter((a) => isArkivEnabled(a.company_id))
    const companies = [...new Set(agreements.map((a) => a.company_id))].slice(0, MAX_COMPANIES)

    const totals = { companies: companies.length, checked: 0, matched: 0, missed: 0, rederived: 0 }
    for (const companyId of companies) {
      const summary = await observeObligations(supabase, companyId, today)
      totals.checked += summary.checked
      totals.matched += summary.matched
      totals.missed += summary.missed
    }
    for (const agreement of agreements.filter((a) => needsRederivation(a.derived_at)).slice(0, REDERIVE_LIMIT)) {
      if (await enqueueDocumentJob(supabase, agreement.company_id, agreement.source_document_id, 'derive')) totals.rederived++
    }
    ctx.log.info('arkiv derive', totals)
    return NextResponse.json({ ok: true, ...totals })
  } catch (err) {
    ctx.log.error('arkiv derive failed', { reason: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ ok: false, error: getErrorMessage(err) }, { status: 500 })
  }
})
