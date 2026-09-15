import type { SupabaseClient } from '@supabase/supabase-js'
import type { Payload } from '@/lib/documents/extract/fields'
import { deriveFacts, type FactDraft } from './derive'
import { hasFactPredicates, type FactSubjectKind } from './predicates'

/**
 * Arkiv phase 5: facts in and out of company_facts. Writes go through the
 * record and revert functions so supersession is atomic and the guard trigger
 * keeps history intact.
 */
export interface FactRow {
  id: string
  company_id: string
  subject_kind: FactSubjectKind
  subject_id: string
  predicate: string
  value: unknown
  value_text: string
  single_valued: boolean
  valid_from: string | null
  valid_to: string | null
  sys_from: string
  sys_to: string | null
  rank: 'preferred' | 'normal' | 'deprecated'
  deprecation_reason: string | null
  supersedes_id: string | null
  status: 'proposed' | 'confirmed'
  source_kind: 'extraction' | 'ledger' | 'registry' | 'person' | 'agent'
  source_document_id: string | null
  source_extraction_id: string | null
  sources: Array<{ document_id?: string; page?: number | null; quote?: string | null; extraction_id?: string; at?: string }>
  confidence: number
  rationale: string | null
  approved_by_user_id: string | null
  created_at: string
}

export interface RecordFactInput {
  companyId: string
  subjectKind: FactSubjectKind
  subjectId: string
  predicate: string
  value: string | number | boolean
  valueText?: string
  singleValued?: boolean
  validFrom?: string | null
  validTo?: string | null
  sourceKind: FactRow['source_kind']
  sourceDocumentId?: string | null
  sourceExtractionId?: string | null
  evidence?: Record<string, unknown> | null
  confidence?: number
  rationale?: string | null
  assertedByAgentId?: string | null
  approvedByUserId?: string | null
}

/** Records one fact through record_company_fact and returns the id that now carries the value. */
export async function recordFact(supabase: SupabaseClient, input: RecordFactInput): Promise<string> {
  const { data, error } = await supabase.rpc('record_company_fact', {
    p_company_id: input.companyId,
    p_subject_kind: input.subjectKind,
    p_subject_id: input.subjectId,
    p_predicate: input.predicate,
    p_value: input.value,
    p_value_text: input.valueText ?? String(input.value),
    p_single_valued: input.singleValued ?? true,
    p_valid_from: input.validFrom ?? null,
    p_valid_to: input.validTo ?? null,
    p_source_kind: input.sourceKind,
    p_source_document_id: input.sourceDocumentId ?? null,
    p_source_extraction_id: input.sourceExtractionId ?? null,
    p_evidence: input.evidence ?? null,
    p_confidence: input.confidence ?? 1,
    p_rationale: input.rationale ?? null,
    p_asserted_by_agent_id: input.assertedByAgentId ?? null,
    p_approved_by_user_id: input.approvedByUserId ?? null,
  })
  if (error) throw new Error(`fact record failed: ${error.message}`)
  return data as string
}

export type RecordFactsOutcome =
  | { status: 'recorded'; facts: number; subjectKind: FactSubjectKind }
  | { status: 'skipped'; reason: 'not_found' | 'not_admitted' | 'no_extraction' | 'no_predicates' | 'no_agreement' }
  | { status: 'error'; reason: string }

/**
 * The settled fields of a document's current record become facts about the
 * company (registrations, decisions) or about its agreement.
 */
export async function recordFactsForDocument(supabase: SupabaseClient, documentId: string): Promise<RecordFactsOutcome> {
  try {
    const { data: doc, error: docError } = await supabase.from('document_attachments').select('id, company_id, admission_state').eq('id', documentId).maybeSingle()
    if (docError) throw new Error(`document fetch failed: ${docError.message}`)
    if (!doc) return { status: 'skipped', reason: 'not_found' }
    const row = doc as { id: string; company_id: string; admission_state: string }
    if (row.admission_state !== 'admitted') return { status: 'skipped', reason: 'not_admitted' }
    const { data: ext, error: extError } = await supabase.from('document_extractions').select('id, schema_type, payload, review_fields').eq('document_id', documentId).eq('is_current', true).maybeSingle()
    if (extError) throw new Error(`extraction fetch failed: ${extError.message}`)
    if (!ext) return { status: 'skipped', reason: 'no_extraction' }
    const extraction = ext as { id: string; schema_type: string; payload: Payload; review_fields: string[] }
    if (!hasFactPredicates(extraction.schema_type)) return { status: 'skipped', reason: 'no_predicates' }
    const drafts = deriveFacts({ schemaType: extraction.schema_type, payload: extraction.payload, reviewFields: extraction.review_fields })
    const subjectKind: FactSubjectKind = drafts[0]?.subjectKind ?? 'company'
    const subjectId = subjectKind === 'agreement' ? await agreementIdFor(supabase, documentId) : row.company_id
    if (!subjectId) return { status: 'skipped', reason: 'no_agreement' }
    for (const draft of drafts) await recordFact(supabase, draftInput(draft, row.company_id, subjectId, documentId, extraction.id))
    return { status: 'recorded', facts: drafts.length, subjectKind }
  } catch (err) {
    return { status: 'error', reason: (err instanceof Error ? err.message : String(err)).slice(0, 300) }
  }
}

function draftInput(draft: FactDraft, companyId: string, subjectId: string, documentId: string, extractionId: string): RecordFactInput {
  return {
    companyId,
    subjectKind: draft.subjectKind,
    subjectId,
    predicate: draft.predicate,
    value: draft.value,
    valueText: draft.valueText,
    singleValued: draft.singleValued,
    validFrom: draft.validFrom,
    validTo: draft.validTo,
    sourceKind: 'extraction',
    sourceDocumentId: documentId,
    sourceExtractionId: extractionId,
    evidence: { document_id: documentId, page: draft.evidence.page, quote: draft.evidence.quote, field: draft.evidence.field, extraction_id: extractionId, at: new Date().toISOString() },
    confidence: 1,
  }
}

async function agreementIdFor(supabase: SupabaseClient, documentId: string): Promise<string | null> {
  const { data, error } = await supabase.from('agreements').select('id').eq('source_document_id', documentId).maybeSingle()
  if (error) throw new Error(`agreement fetch failed: ${error.message}`)
  return (data as { id: string } | null)?.id ?? null
}

/** Live facts of a subject: believed now, not deprecated, confirmed. */
export async function listLiveFacts(supabase: SupabaseClient, companyId: string, subject: { kind: FactSubjectKind; id: string }, asOf?: string | null): Promise<FactRow[]> {
  let query = supabase
    .from('company_facts')
    .select('id, company_id, subject_kind, subject_id, predicate, value, value_text, single_valued, valid_from, valid_to, sys_from, sys_to, rank, deprecation_reason, supersedes_id, status, source_kind, source_document_id, source_extraction_id, sources, confidence, rationale, approved_by_user_id, created_at')
    .eq('company_id', companyId)
    .eq('subject_kind', subject.kind)
    .eq('subject_id', subject.id)
    .is('sys_to', null)
    .neq('rank', 'deprecated')
    .eq('status', 'confirmed')
    .order('predicate', { ascending: true })
  if (asOf) query = query.or(`valid_from.is.null,valid_from.lte.${asOf}`).or(`valid_to.is.null,valid_to.gte.${asOf}`)
  const { data, error } = await query
  if (error) throw new Error(`facts fetch failed: ${error.message}`)
  return (data ?? []) as FactRow[]
}

/** Every reading a subject ever had, newest belief first, optionally one predicate. */
export async function factHistory(supabase: SupabaseClient, companyId: string, subject: { kind: FactSubjectKind; id: string }, predicate?: string | null): Promise<FactRow[]> {
  let query = supabase.from('company_facts').select('id, company_id, subject_kind, subject_id, predicate, value, value_text, single_valued, valid_from, valid_to, sys_from, sys_to, rank, deprecation_reason, supersedes_id, status, source_kind, source_document_id, source_extraction_id, sources, confidence, rationale, approved_by_user_id, created_at').eq('company_id', companyId).eq('subject_kind', subject.kind).eq('subject_id', subject.id).order('sys_from', { ascending: false }).limit(200)
  if (predicate) query = query.eq('predicate', predicate)
  const { data, error } = await query
  if (error) throw new Error(`fact history fetch failed: ${error.message}`)
  return (data ?? []) as FactRow[]
}

/** Deprecates a fact with a reason and reinstates what it superseded; returns the reinstated fact id, if any. */
export async function revertFact(supabase: SupabaseClient, factId: string, reason: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('revert_company_fact', { p_fact_id: factId, p_reason: reason })
  if (error) throw new Error(`fact revert failed: ${error.message}`)
  return (data as string | null) ?? null
}
