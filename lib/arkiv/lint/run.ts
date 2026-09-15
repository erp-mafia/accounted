import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { addDays } from '@/lib/arkiv/agreements/dates'
import { AUDIT_WINDOW_DAYS, autonomyLevel, tallyAudits } from './autonomy'
import {
  agreementFindings,
  duplicateDocuments,
  settingsMismatches,
  stuckDocuments,
  type AgreementForLint,
  type DocumentContent,
  type FindingDraft,
  type LiveFact,
  type SettingsSnapshot,
  type StuckJob,
} from './checks'

const log = createLogger('arkiv/lint')

/**
 * Arkiv phase 6: one company's nightly lint. Runs every check, files new
 * findings, refreshes the ones still true, closes the ones that went away,
 * and recomputes the autonomy level per document type from the audits of
 * the last 90 days. Service role: findings are per company and invisible
 * across tenants by RLS.
 */
export interface LintSummary {
  findings: number
  opened: number
  closed: number
  autonomy: number
}

interface FindingRow {
  id: string
  key: string
  status: 'open' | 'resolved' | 'dismissed'
}

export async function lintCompany(supabase: SupabaseClient, companyId: string, today: string): Promise<LintSummary> {
  const drafts = [
    ...settingsMismatches(await loadLiveCompanyFacts(supabase, companyId), await loadSettings(supabase, companyId)),
    ...agreementFindings(await loadAgreements(supabase, companyId), today),
    ...duplicateDocuments(await loadDocumentContents(supabase, companyId)),
    ...stuckDocuments(await loadStuckJobs(supabase, companyId)),
  ]
  const { opened, closed } = await fileFindings(supabase, companyId, drafts)
  const autonomy = await computeAutonomy(supabase, companyId, today)
  return { findings: drafts.length, opened, closed, autonomy }
}

async function fileFindings(supabase: SupabaseClient, companyId: string, drafts: FindingDraft[]): Promise<{ opened: number; closed: number }> {
  const { data, error } = await supabase.from('arkiv_findings').select('id, key, status').eq('company_id', companyId)
  if (error) throw new Error(`findings fetch failed: ${error.message}`)
  const existing = new Map(((data ?? []) as FindingRow[]).map((f) => [f.key, f]))
  const now = new Date().toISOString()
  let opened = 0
  for (const draft of drafts) {
    const row = existing.get(draft.key)
    if (!row) {
      const { error: insertError } = await supabase.from('arkiv_findings').insert({
        company_id: companyId,
        kind: draft.kind,
        key: draft.key,
        severity: draft.severity,
        subject_kind: draft.subjectKind,
        subject_id: draft.subjectId,
        detail: draft.detail,
        status: 'open',
        first_seen_at: now,
        last_seen_at: now,
      })
      if (insertError) throw new Error(`finding insert failed: ${insertError.message}`)
      opened++
      continue
    }
    // Still true: refresh what it says. A dismissed finding stays dismissed; a resolved one that comes back reopens.
    if (row.status === 'resolved') {
      const { error: reopenError } = await supabase
        .from('arkiv_findings')
        .update({ detail: draft.detail, severity: draft.severity, last_seen_at: now, status: 'open', resolved_at: null, resolved_by_user_id: null, resolution: null })
        .eq('id', row.id)
      if (reopenError) throw new Error(`finding reopen failed: ${reopenError.message}`)
      opened++
      continue
    }
    const { error: updateError } = await supabase.from('arkiv_findings').update({ detail: draft.detail, severity: draft.severity, last_seen_at: now }).eq('id', row.id)
    if (updateError) throw new Error(`finding update failed: ${updateError.message}`)
  }
  const keys = new Set(drafts.map((d) => d.key))
  const gone = [...existing.values()].filter((f) => f.status === 'open' && !keys.has(f.key))
  if (gone.length) {
    const { error: closeError } = await supabase
      .from('arkiv_findings')
      .update({ status: 'resolved', resolution: 'gone', resolved_at: now })
      .in(
        'id',
        gone.map((f) => f.id),
      )
    if (closeError) throw new Error(`finding close failed: ${closeError.message}`)
  }
  return { opened, closed: gone.length }
}

/** Audits per schema type in the window, written as the company's autonomy levels. */
export async function computeAutonomy(supabase: SupabaseClient, companyId: string, today: string): Promise<number> {
  const { data, error } = await supabase
    .from('activities')
    .select('schema_type, detail')
    .eq('company_id', companyId)
    .eq('kind', 'review')
    .gte('started_at', addDays(today, -AUDIT_WINDOW_DAYS))
    .limit(5000)
  if (error) throw new Error(`activities fetch failed: ${error.message}`)
  const tallies = tallyAudits((data ?? []) as Array<{ schema_type: string | null; detail: unknown }>)
  const now = new Date().toISOString()
  let written = 0
  for (const [schemaType, tally] of tallies) {
    const { error: upsertError } = await supabase
      .from('arkiv_autonomy')
      .upsert(
        { company_id: companyId, schema_type: schemaType, level: autonomyLevel(tally), audited: tally.audited, changed: tally.changed, computed_at: now },
        { onConflict: 'company_id,schema_type' },
      )
    if (upsertError) throw new Error(`autonomy upsert failed: ${upsertError.message}`)
    written++
  }
  return written
}

async function loadSettings(supabase: SupabaseClient, companyId: string): Promise<SettingsSnapshot> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('company_name, org_number, f_skatt, vat_registered, employer_registered, moms_period, accounting_method, fiscal_year_start_month')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`settings fetch failed: ${error.message}`)
  const row = (data ?? {}) as Partial<SettingsSnapshot>
  return {
    company_name: row.company_name ?? null,
    org_number: row.org_number ?? null,
    f_skatt: row.f_skatt ?? null,
    vat_registered: row.vat_registered ?? null,
    employer_registered: row.employer_registered ?? null,
    moms_period: row.moms_period ?? null,
    accounting_method: row.accounting_method ?? null,
    fiscal_year_start_month: row.fiscal_year_start_month ?? null,
  }
}

async function loadLiveCompanyFacts(supabase: SupabaseClient, companyId: string): Promise<LiveFact[]> {
  const { data, error } = await supabase
    .from('company_facts')
    .select('id, predicate, value_text, source_document_id, sources')
    .eq('company_id', companyId)
    .eq('subject_kind', 'company')
    .eq('subject_id', companyId)
    .eq('status', 'confirmed')
    .is('sys_to', null)
    .neq('rank', 'deprecated')
    .limit(500)
  if (error) throw new Error(`facts fetch failed: ${error.message}`)
  return (data ?? []) as LiveFact[]
}

async function loadAgreements(supabase: SupabaseClient, companyId: string): Promise<AgreementForLint[]> {
  const { data, error } = await supabase
    .from('agreements')
    .select('id, title, status, ends_on, notice_months, counterparty_party_id, counterparty_name')
    .eq('company_id', companyId)
    .limit(1000)
  if (error) throw new Error(`agreements fetch failed: ${error.message}`)
  return (data ?? []) as AgreementForLint[]
}

async function loadDocumentContents(supabase: SupabaseClient, companyId: string): Promise<DocumentContent[]> {
  const { data, error } = await supabase
    .from('document_classifications')
    .select('document_id, content_sha256, document_attachments!inner(file_name, admission_state)')
    .eq('company_id', companyId)
    .eq('is_current', true)
    .not('content_sha256', 'is', null)
    .limit(5000)
  if (error) throw new Error(`classifications fetch failed: ${error.message}`)
  const rows = (data ?? []) as unknown as Array<{
    document_id: string
    content_sha256: string | null
    document_attachments: { file_name: string; admission_state: string } | Array<{ file_name: string; admission_state: string }>
  }>
  return rows
    .map((r) => ({ document_id: r.document_id, content_sha256: r.content_sha256, doc: Array.isArray(r.document_attachments) ? r.document_attachments[0] : r.document_attachments }))
    .filter((r) => r.doc?.admission_state === 'admitted')
    .map((r) => ({ document_id: r.document_id, file_name: r.doc.file_name, content_sha256: r.content_sha256 }))
}

async function loadStuckJobs(supabase: SupabaseClient, companyId: string): Promise<StuckJob[]> {
  const { data, error } = await supabase
    .from('document_jobs')
    .select('document_id, kind, attempts, max_attempts, last_error, document_attachments!inner(file_name)')
    .eq('company_id', companyId)
    .eq('status', 'failed')
    .limit(500)
  if (error) throw new Error(`jobs fetch failed: ${error.message}`)
  const rows = (data ?? []) as unknown as Array<{
    document_id: string
    kind: string
    attempts: number
    max_attempts: number
    last_error: string | null
    document_attachments: { file_name: string } | Array<{ file_name: string }>
  }>
  return rows
    .filter((r) => r.attempts >= r.max_attempts)
    .map((r) => ({
      document_id: r.document_id,
      kind: r.kind,
      last_error: r.last_error,
      file_name: (Array.isArray(r.document_attachments) ? r.document_attachments[0] : r.document_attachments)?.file_name ?? '',
    }))
}

export async function lintCompanies(supabase: SupabaseClient, companyIds: string[], today: string): Promise<Record<string, LintSummary | { error: string }>> {
  const out: Record<string, LintSummary | { error: string }> = {}
  for (const companyId of companyIds) {
    try {
      out[companyId] = await lintCompany(supabase, companyId, today)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log.warn('lint failed', { company: companyId, reason })
      out[companyId] = { error: reason.slice(0, 200) }
    }
  }
  return out
}
