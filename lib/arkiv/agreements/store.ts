import type { SupabaseClient } from '@supabase/supabase-js'
import type { Payload } from '@/lib/documents/extract/fields'
import { humanAgent, recordActivity, softwareAgent } from '@/lib/documents/provenance'
import { addDays, addMonths, daysBetween, todayIso } from './dates'
import { resolveCounterparty } from './counterparty'
import { deriveAgreement, HORIZON, type AgreementDraft, type DeadlineDraft, type Derivation, type ObligationDraft } from './derive'

/**
 * Arkiv phase 4: turn the current record of an agreement into rows that
 * already mean something to the rest of the product: a party link, an
 * agreements row, its obligations, and deadlines in Viktiga datum, each
 * pointing back at the page it came from. Idempotent: a rerun updates what
 * the record now says and leaves what a person or a bank transaction settled.
 */
export const DERIVER = { name: 'arkiv.derive', version: '1' } as const

export type DeriveOutcome =
  | {
      status: 'derived'
      agreementId: string
      obligations: number
      deadlines: number
      counterparty: 'proven' | 'guessed' | null
      waitingOn: string[]
    }
  | {
      status: 'skipped'
      reason: 'not_found' | 'not_admitted' | 'not_agreement' | 'no_extraction'
    }
  | { status: 'error'; reason: string }

interface DocumentRow {
  id: string
  company_id: string
  user_id: string
  file_name: string
  admission_state: 'held' | 'admitted'
}

interface ExtractionRow {
  id: string
  schema_type: string
  payload: Payload
  review_fields: string[]
}

export async function deriveDocument(supabase: SupabaseClient, documentId: string, opts: { today?: string } = {}): Promise<DeriveOutcome> {
  const today = opts.today ?? todayIso()
  try {
    const doc = await loadDocument(supabase, documentId)
    if (!doc) return { status: 'skipped', reason: 'not_found' }
    if (doc.admission_state !== 'admitted') return { status: 'skipped', reason: 'not_admitted' }
    const extraction = await loadCurrentExtraction(supabase, documentId)
    if (!extraction) return { status: 'skipped', reason: 'no_extraction' }
    const derivation = deriveAgreement({
      schemaType: extraction.schema_type,
      payload: extraction.payload,
      reviewFields: extraction.review_fields,
      today,
    })
    if (!derivation) return { status: 'skipped', reason: 'not_agreement' }

    const counterparty = await resolveCounterparty(supabase, {
      companyId: doc.company_id,
      userId: doc.user_id,
      documentId,
      name: derivation.agreement.counterparty.name,
      orgNumber: derivation.agreement.counterparty.orgNumber,
      citation: citationFor(derivation.agreement, [
        'landlord_org_number',
        'lessor_org_number',
        'lender_org_number',
        'provider_org_number',
        'landlord_name',
        'lessor_name',
        'lender_name',
        'provider_name',
      ]),
    })
    const activityId = await recordActivity(supabase, {
      companyId: doc.company_id,
      documentId,
      agentId: await softwareAgent(supabase, DERIVER.name, DERIVER.version),
      kind: 'derive',
      schemaType: extraction.schema_type,
      outcome: derivation.waitingOn.length ? 'review' : 'settled',
      detail: {
        waiting_on: derivation.waitingOn,
        counterparty: 'reason' in counterparty ? counterparty.reason : counterparty.basis,
      },
    })
    const agreementId = await upsertAgreement(supabase, doc, extraction.id, derivation.agreement, counterparty.partyId, today)
    if (counterparty.partyId) {
      await retireOtherPartyLinks(supabase, documentId, counterparty.partyId)
      await ensureLink(supabase, {
        companyId: doc.company_id,
        documentId,
        targetId: counterparty.partyId,
        targetKind: 'party',
        basis: counterparty.basis,
        method: counterparty.method,
        confidence: counterparty.confidence,
        evidence:
          citationFor(derivation.agreement, [
            'landlord_org_number',
            'lessor_org_number',
            'lender_org_number',
            'provider_org_number',
            'landlord_name',
            'lessor_name',
            'lender_name',
            'provider_name',
          ]) ?? {},
        activityId,
      })
    }
    await ensureLink(supabase, {
      companyId: doc.company_id,
      documentId,
      targetId: agreementId,
      targetKind: 'agreement',
      basis: 'proven',
      method: 'derived',
      confidence: 1,
      evidence: {},
      activityId,
    })
    const obligations = await syncObligations(supabase, doc.company_id, agreementId, derivation.obligations, today)
    const deadlines = await syncDeadlines(supabase, doc, agreementId, derivation, today)
    return {
      status: 'derived',
      agreementId,
      obligations,
      deadlines,
      counterparty: counterparty.partyId ? counterparty.basis : null,
      waitingOn: derivation.waitingOn,
    }
  } catch (err) {
    return {
      status: 'error',
      reason: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    }
  }
}

/** A person links a document to a party, an agreement or an asset. */
export async function linkByPerson(
  supabase: SupabaseClient,
  input: {
    companyId: string
    documentId: string
    userId: string
    targetKind: 'party' | 'agreement' | 'asset'
    targetId: string
  },
): Promise<{ id: string } | { conflict: true }> {
  const { data, error } = await supabase
    .from('document_links')
    .insert({
      company_id: input.companyId,
      document_id: input.documentId,
      target_kind: input.targetKind,
      party_id: input.targetKind === 'party' ? input.targetId : null,
      agreement_id: input.targetKind === 'agreement' ? input.targetId : null,
      asset_id: input.targetKind === 'asset' ? input.targetId : null,
      basis: 'proven',
      method: 'person',
      confidence: 1,
      created_by_user_id: input.userId,
      activity_id: await recordActivity(supabase, {
        companyId: input.companyId,
        documentId: input.documentId,
        agentId: await humanAgent(supabase, input.userId),
        kind: 'review',
        outcome: 'settled',
        detail: { link: input.targetKind, target_id: input.targetId },
      }),
    })
    .select('id')
    .single()
  if (error?.code === '23505') return { conflict: true }
  if (error) throw new Error(`link insert failed: ${error.message}`)
  return { id: (data as { id: string }).id }
}

async function loadDocument(supabase: SupabaseClient, documentId: string): Promise<DocumentRow | null> {
  const { data, error } = await supabase.from('document_attachments').select('id, company_id, user_id, file_name, admission_state').eq('id', documentId).maybeSingle()
  if (error) throw new Error(`document fetch failed: ${error.message}`)
  return data as DocumentRow | null
}

async function loadCurrentExtraction(supabase: SupabaseClient, documentId: string): Promise<ExtractionRow | null> {
  const { data, error } = await supabase
    .from('document_extractions')
    .select('id, schema_type, payload, review_fields')
    .eq('document_id', documentId)
    .eq('is_current', true)
    .maybeSingle()
  if (error) throw new Error(`extraction fetch failed: ${error.message}`)
  return data as ExtractionRow | null
}

function citationFor(agreement: AgreementDraft, fields: string[]): { field: string; page: number | null; quote: string | null } | null {
  for (const field of fields) {
    const source = agreement.sources[field]
    if (source) return { field, ...source }
  }
  return null
}

async function upsertAgreement(supabase: SupabaseClient, doc: DocumentRow, extractionId: string, draft: AgreementDraft, partyId: string | null, today: string): Promise<string> {
  const { data, error } = await supabase
    .from('agreements')
    .upsert(
      {
        company_id: doc.company_id,
        kind: draft.kind,
        title: draft.title.slice(0, 200),
        counterparty_party_id: partyId,
        counterparty_name: draft.counterparty.name,
        starts_on: draft.startsOn,
        ends_on: draft.endsOn,
        notice_months: draft.noticeMonths,
        renewal_terms: draft.renewalTerms,
        amount: draft.amount,
        currency: draft.currency,
        period: draft.period,
        principal: draft.principal,
        interest_rate: draft.interestRate,
        status: draft.endsOn && draft.endsOn < today ? 'ended' : 'active',
        source_document_id: doc.id,
        source_extraction_id: extractionId,
        sources: draft.sources,
        derived_at: new Date().toISOString(),
      },
      { onConflict: 'source_document_id' },
    )
    .select('id')
    .single()
  if (error) throw new Error(`agreement upsert failed: ${error.message}`)
  return (data as { id: string }).id
}

async function retireOtherPartyLinks(supabase: SupabaseClient, documentId: string, partyId: string): Promise<void> {
  const { error } = await supabase
    .from('document_links')
    .update({
      retired_at: new Date().toISOString(),
      retired_reason: 'counterparty changed on re-derivation',
    })
    .eq('document_id', documentId)
    .eq('target_kind', 'party')
    .neq('party_id', partyId)
    .neq('method', 'person')
    .is('retired_at', null)
  if (error) throw new Error(`link retire failed: ${error.message}`)
}

async function ensureLink(
  supabase: SupabaseClient,
  link: {
    companyId: string
    documentId: string
    targetKind: 'party' | 'agreement'
    targetId: string
    basis: 'proven' | 'guessed'
    method: string
    confidence: number
    evidence: Record<string, unknown>
    activityId: string
  },
): Promise<void> {
  const { data: existing, error: readError } = await supabase
    .from('document_links')
    .select('id')
    .eq('document_id', link.documentId)
    .eq('target_kind', link.targetKind)
    .eq('target_id', link.targetId)
    .is('retired_at', null)
    .maybeSingle()
  if (readError) throw new Error(`link fetch failed: ${readError.message}`)
  if (existing) return
  const { error } = await supabase.from('document_links').insert({
    company_id: link.companyId,
    document_id: link.documentId,
    target_kind: link.targetKind,
    party_id: link.targetKind === 'party' ? link.targetId : null,
    agreement_id: link.targetKind === 'agreement' ? link.targetId : null,
    basis: link.basis,
    method: link.method,
    confidence: link.confidence,
    evidence: link.evidence,
    activity_id: link.activityId,
  })
  if (error) throw new Error(`link insert failed: ${error.message}`)
}

interface ObligationRow {
  id: string
  kind: string
  due_on: string
  amount: number
  amount_is_estimate: boolean
  status: string
}

/**
 * The schedule inside the horizon becomes rows: new dates are inserted,
 * expected rows that changed are updated, expected rows the record no longer
 * implies are removed. Matched, missed and waived rows are never touched.
 */
async function syncObligations(supabase: SupabaseClient, companyId: string, agreementId: string, drafts: ObligationDraft[], today: string): Promise<number> {
  const { data, error } = await supabase.from('agreement_obligations').select('id, kind, due_on, amount, amount_is_estimate, status').eq('agreement_id', agreementId)
  if (error) throw new Error(`obligations fetch failed: ${error.message}`)
  const existing = new Map(((data ?? []) as ObligationRow[]).map((o) => [`${o.kind}:${o.due_on}`, o]))
  const wanted = new Map(drafts.map((d) => [`${d.kind}:${d.dueOn}`, d]))

  const inserts = drafts
    .filter((d) => !existing.has(`${d.kind}:${d.dueOn}`))
    .map((d) => ({
      company_id: companyId,
      agreement_id: agreementId,
      kind: d.kind,
      due_on: d.dueOn,
      amount: d.amount,
      currency: d.currency,
      amount_is_estimate: d.estimate,
      evidence: { fields: d.fields },
    }))
  if (inserts.length) {
    const { error: insertError } = await supabase.from('agreement_obligations').insert(inserts)
    if (insertError) throw new Error(`obligations insert failed: ${insertError.message}`)
  }
  for (const [key, row] of existing) {
    if (row.status !== 'expected') continue
    const draft = wanted.get(key)
    if (draft) {
      if (Number(row.amount) === draft.amount && row.amount_is_estimate === draft.estimate) continue
      const { error: updateError } = await supabase
        .from('agreement_obligations')
        .update({
          amount: draft.amount,
          amount_is_estimate: draft.estimate,
          evidence: { fields: draft.fields },
        })
        .eq('id', row.id)
      if (updateError) throw new Error(`obligation update failed: ${updateError.message}`)
    } else if (row.due_on >= addDays(today, -HORIZON.pastDays)) {
      const { error: deleteError } = await supabase.from('agreement_obligations').delete().eq('id', row.id)
      if (deleteError) throw new Error(`obligation delete failed: ${deleteError.message}`)
    }
  }
  return drafts.length
}

interface DeadlineRow {
  id: string
  source_key: string
  title: string
  due_date: string
  is_completed: boolean
  dismissed_at: string | null
  status: string
}

/** Upcoming: more than two weeks away; action needed within two weeks; overdue when passed. Same thresholds as the status engine. */
export function initialDeadlineStatus(dueOn: string, today: string): 'upcoming' | 'action_needed' | 'overdue' {
  const days = daysBetween(today, dueOn)
  if (days < 0) return 'overdue'
  return days <= 14 ? 'action_needed' : 'upcoming'
}

async function syncDeadlines(supabase: SupabaseClient, doc: DocumentRow, agreementId: string, derivation: Derivation, today: string): Promise<number> {
  const prefix = `agreement:${agreementId}:`
  const { data, error } = await supabase
    .from('deadlines')
    .select('id, source_key, title, due_date, is_completed, dismissed_at, status')
    .eq('company_id', doc.company_id)
    .like('source_key', `${prefix}%`)
  if (error) throw new Error(`deadlines fetch failed: ${error.message}`)
  const existing = new Map(((data ?? []) as DeadlineRow[]).map((d) => [d.source_key, d]))
  const now = new Date().toISOString()

  for (const draft of derivation.deadlines) {
    const key = `${prefix}${draft.key}`
    const row = existing.get(key)
    const notes = noteFor(doc.file_name, derivation.agreement, draft)
    if (!row) {
      const { error: insertError } = await supabase.from('deadlines').insert({
        company_id: doc.company_id,
        user_id: null,
        title: draft.title,
        due_date: draft.dueOn,
        deadline_type: 'other',
        priority: draft.priority,
        is_completed: false,
        source: 'system',
        status: initialDeadlineStatus(draft.dueOn, today),
        status_changed_at: now,
        notes,
        is_auto_generated: true,
        reminder_offsets: [14, 7, 1, 0],
        source_document_id: doc.id,
        source_key: key,
      })
      if (insertError) throw new Error(`deadline insert failed: ${insertError.message}`)
      continue
    }
    // A person's opt-out or completion stands whatever the record now says.
    if (row.dismissed_at || row.is_completed) continue
    if (row.due_date === draft.dueOn && row.title === draft.title) continue
    // A moved date gets its status recomputed unless a person is working on it.
    const recompute = row.due_date !== draft.dueOn && ['upcoming', 'action_needed', 'overdue'].includes(row.status)
    const { error: updateError } = await supabase
      .from('deadlines')
      .update({
        title: draft.title,
        due_date: draft.dueOn,
        priority: draft.priority,
        notes,
        status: recompute ? initialDeadlineStatus(draft.dueOn, today) : row.status,
        status_changed_at: recompute ? now : undefined,
      })
      .eq('id', row.id)
    if (updateError) throw new Error(`deadline update failed: ${updateError.message}`)
  }
  const wanted = new Set(derivation.deadlines.map((d) => `${prefix}${d.key}`))
  for (const [key, row] of existing) {
    if (wanted.has(key) || row.dismissed_at || row.is_completed) continue
    const { error: deleteError } = await supabase.from('deadlines').delete().eq('id', row.id)
    if (deleteError) throw new Error(`deadline delete failed: ${deleteError.message}`)
  }
  return derivation.deadlines.length
}

/** "Enligt hyresavtal.pdf, sida 2 (ends_on, notice_months)." */
function noteFor(fileName: string, agreement: AgreementDraft, draft: DeadlineDraft): string {
  const pages = [...new Set(draft.fields.map((f) => agreement.sources[f]?.page).filter((p): p is number => p != null))].sort((a, b) => a - b)
  const where = pages.length ? `, sida ${pages.join(' och ')}` : ''
  return `Enligt ${fileName}${where}. Datumet räknas fram från ${draft.fields.join(', ')}.`
}

/** Re-derivation keeps the horizon rolling: agreements derived more than a week ago are due again. */
export function needsRederivation(derivedAt: string, now: Date = new Date()): boolean {
  return now.getTime() - new Date(derivedAt).getTime() > 7 * 86_400_000
}

export { addMonths }
