import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { arkivBrainRollout, isArkivBrainEnabled } from '@/lib/arkiv/flag'
import { deriveCompanyFacts } from '@/lib/arkiv/facts/derive-company'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { observeObligations } from '@/lib/arkiv/agreements/observe'
import { needsRederivation } from '@/lib/arkiv/agreements/store'
import { todayIso } from '@/lib/arkiv/agreements/dates'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'
import { commitmentsEnabledFor, commitmentsRolloutConfigured } from '@/lib/env/commitments-switch'
import { refreshManualAgreements } from '@/lib/commitments/agreements'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/arkiv/derive/cron
 * Arkiv phase 4, daily: compares every company's expected payments with its
 * bank transactions (matched, missed; observation only), and queues a fresh
 * derivation for agreements older than a week so the schedule keeps rolling
 * a year ahead. Then recomputes each rollout company's facts from the
 * ledger, the registers and the Bolagsverket snapshot (phase 10, step 1).
 *
 * Bolaget (BOLAGET_COMPANY_IDS): the agreements a person registered by hand
 * keep their schedule rolling (expected payments a year ahead, notice and
 * end dates) and are observed against the bank too, also for a company
 * outside the brain rollout. The brain's own pass is unchanged.
 */
export const maxDuration = 300

const MAX_COMPANIES = 50
const REDERIVE_LIMIT = 100

interface AgreementRow {
  company_id: string
  source_document_id: string
  derived_at: string
}

interface ManualAgreementCompanyRow {
  company_id: string
}

export const GET = withCronContext('arkiv.derive', async (_request, ctx) => {
  const supabase = createServiceRoleClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const today = todayIso()
  try {
    // Paged, oldest derivation first: PostgREST cuts a single read at 1000 rows, which hid the
    // rollout companies whose agreements sorted past it. id breaks derived_at ties for stable pages.
    const data = await fetchAllRows<AgreementRow>((range) =>
      supabase
        .from('agreements')
        .select('company_id, source_document_id, derived_at')
        // The documents' agreements only: a manual one has no document to re-derive.
        .not('source_document_id', 'is', null)
        .order('derived_at', { ascending: true })
        .order('id', { ascending: true })
        .range(range.from, range.to),
    )
    const agreements = data.filter((a) => isArkivBrainEnabled(a.company_id))
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
    // Bolaget: only when the rollout names a company, so the brain's pass runs exactly as before otherwise.
    const manual = commitmentsRolloutConfigured() ? await refreshManualCompanies(supabase, today, new Set(companies), ctx.log) : null
    // Company facts for every company in the rollout: a listed rollout names them; `*` waits for the brain to open to everyone.
    const rollout = arkivBrainRollout()
    const factsFor = rollout === 'all' ? [] : rollout.slice(0, MAX_COMPANIES)
    const facts = { companies: factsFor.length, recorded: 0, retired: 0, failed: 0 }
    for (const companyId of factsFor) {
      try {
        const out = await deriveCompanyFacts(supabase, companyId, today, (account) => getBASReference(account)?.account_name ?? null)
        facts.recorded += out.recorded
        facts.retired += out.retired
      } catch (err) {
        facts.failed++
        ctx.log.warn('company facts not derived', { company: companyId, reason: err instanceof Error ? err.message : String(err) })
      }
    }
    ctx.log.info('arkiv derive', { ...totals, facts, ...(manual ? { manual } : {}) })
    return NextResponse.json({ ok: true, ...totals, facts, ...(manual ? { manual } : {}) })
  } catch (err) {
    ctx.log.error('arkiv derive failed', { reason: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ ok: false, error: getErrorMessage(err) }, { status: 500 })
  }
})

/**
 * The manual agreements of every company in the Bolaget rollout: their
 * schedules are refreshed, and their obligations observed unless the brain
 * pass above already observed the company. Fails open: a company that
 * fails is logged and skipped, and a table not yet migrated skips the pass,
 * so the brain's result above stands either way.
 */
async function refreshManualCompanies(
  supabase: SupabaseClient,
  today: string,
  observedByBrain: Set<string>,
  log: Logger,
): Promise<{ companies: number; refreshed: number; checked: number; matched: number; missed: number; failed: number }> {
  const out = { companies: 0, refreshed: 0, checked: 0, matched: 0, missed: 0, failed: 0 }
  let rows: ManualAgreementCompanyRow[]
  try {
    rows = await fetchAllRows<ManualAgreementCompanyRow>((range) =>
      supabase
        .from('agreements')
        .select('company_id')
        .eq('origin', 'manual')
        .eq('status', 'active')
        .order('id', { ascending: true })
        .range(range.from, range.to),
    )
  } catch (err) {
    log.warn('manual agreements not read', { reason: err instanceof Error ? err.message : String(err) })
    return out
  }
  const companies = [...new Set(rows.map((r) => r.company_id))].filter((id) => commitmentsEnabledFor(id)).slice(0, MAX_COMPANIES)
  out.companies = companies.length
  for (const companyId of companies) {
    try {
      const { agreementIds, refreshed } = await refreshManualAgreements(supabase, companyId, today)
      out.refreshed += refreshed
      if (observedByBrain.has(companyId)) continue
      const summary = await observeObligations(supabase, companyId, today, { agreementIds })
      out.checked += summary.checked
      out.matched += summary.matched
      out.missed += summary.missed
    } catch (err) {
      out.failed++
      log.warn('manual agreements not refreshed', { company: companyId, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}
