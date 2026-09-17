import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { getAiService, getAiStatus } from '@/lib/ai'
import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import { DOC_TYPES, DOC_TYPE_DESCRIPTIONS, type DocType } from './taxonomy'
import { captureArkivEvent } from '@/lib/arkiv/events'

const log = createLogger('documents/classify')

/**
 * Arkiv phase 2: say what a document is, and whether it belongs to the
 * company at all. Runs on the stored page text (first and last page), so it
 * costs one cheap-tier call and never re-reads the file. A person's decision
 * is never overwritten by the model.
 */
export const Classification = z.object({
  doc_type: z.enum(DOC_TYPES),
  confidence: z.number().min(0).max(1),
  language: z.string().nullable().default(null),
  is_multi_document: z.boolean().default(false),
  relevance: z.enum(['relevant', 'ask', 'irrelevant']),
  relevance_reason: z.string().default(''),
  addressed_to: z.string().nullable().default(null),
  summary: z.string().default(''),
  suggested_type: z.string().nullable().default(null),
})
export type Classification = z.infer<typeof Classification>

export const CLASSIFICATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['doc_type', 'confidence', 'relevance', 'relevance_reason', 'summary'],
  properties: {
    doc_type: { type: 'string', enum: [...DOC_TYPES] },
    confidence: { type: 'number', description: 'How sure you are about doc_type, 0 to 1.' },
    language: { type: ['string', 'null'], description: 'ISO 639-1 code of the document language.' },
    is_multi_document: { type: 'boolean', description: 'True when several separate documents are bundled in one file.' },
    relevance: { type: 'string', enum: ['relevant', 'ask', 'irrelevant'] },
    relevance_reason: { type: 'string', description: 'One sentence in Swedish.' },
    addressed_to: { type: ['string', 'null'], description: 'The company or person the document is addressed to or concerns.' },
    summary: { type: 'string', description: 'Two sentences in Swedish: what the document is and what it says.' },
    suggested_type: { type: ['string', 'null'], description: 'A short label when doc_type is other, else null.' },
  },
} as const

export interface CompanyIdentity {
  name: string
  orgNumber: string | null
  formerNames?: string[]
}

export function buildClassifySystem(company: CompanyIdentity): string {
  const former = company.formerNames?.length ? ` The company was formerly named ${company.formerNames.join(', ')}.` : ''
  const taxonomy = DOC_TYPES.map((t) => `- ${t}: ${DOC_TYPE_DESCRIPTIONS[t]}`).join('\n')
  return `You classify business documents for a Swedish accounting archive. The archive belongs to ${company.name}${company.orgNumber ? ` (organisationsnummer ${company.orgNumber})` : ''}.${former}

You are given the text of the first and last page of one document. Choose exactly one doc_type:
${taxonomy}

Relevance:
- relevant: the document concerns this company's finances, obligations, structure, ownership, people or business. A receipt or invoice with an amount is relevant even when the buyer is not named: it may be an expense claim.
- ask: nothing ties the document to the company (no amount, no counterparty, no organisation number, no text about the business), or it is clearly addressed to a different company.
- irrelevant: clearly private or unrelated content (a holiday photo, a screenshot of a chat).
Never guess a type to avoid 'other'. Never invent facts that are not in the text.`
}

export function buildClassifyPrompt(input: { fileName: string; pageCount: number | null; firstPage: string; lastPage: string | null }): string {
  const parts = [`File name: ${input.fileName}`, `Pages: ${input.pageCount ?? 'unknown'}`, '', 'FIRST PAGE:', input.firstPage.slice(0, 6000)]
  if (input.lastPage) parts.push('', 'LAST PAGE:', input.lastPage.slice(0, 3000))
  parts.push('', 'Classify this document.')
  return parts.join('\n')
}

export type ClassifyOutcome =
  | { status: 'classified'; classification: Classification; admission: 'admitted' | 'held' }
  | { status: 'skipped'; reason: 'no_pages' | 'human_decided' | 'ai_unconfigured' | 'not_found' }
  | { status: 'error'; reason: string }

interface DocumentRow {
  id: string
  company_id: string
  user_id: string | null
  file_name: string
  page_count: number | null
  admission_state: 'held' | 'admitted'
}

export async function classifyDocument(supabase: SupabaseClient, documentId: string, company: CompanyIdentity): Promise<ClassifyOutcome> {
  if (!getAiStatus().configured) return { status: 'skipped', reason: 'ai_unconfigured' }
  const { data: doc, error: docError } = await supabase
    .from('document_attachments')
    .select('id, company_id, user_id, file_name, page_count, admission_state')
    .eq('id', documentId)
    .maybeSingle()
  if (docError) return { status: 'error', reason: `document fetch failed: ${docError.message}` }
  if (!doc) return { status: 'skipped', reason: 'not_found' }
  const row = doc as DocumentRow

  const { data: current } = await supabase
    .from('document_classifications')
    .select('id, decided_by')
    .eq('document_id', documentId)
    .eq('is_current', true)
    .maybeSingle()
  if (current && (current as { decided_by: string }).decided_by === 'human') return { status: 'skipped', reason: 'human_decided' }

  const { data: pages, error: pagesError } = await supabase
    .from('document_pages')
    .select('page_no, text, reader, has_text_layer')
    .eq('document_id', documentId)
    .order('page_no', { ascending: true })
  if (pagesError) return { status: 'error', reason: `pages fetch failed: ${pagesError.message}` }
  const list = (pages ?? []) as Array<{ page_no: number; text: string; reader: string; has_text_layer: boolean }>
  if (list.length === 0) return { status: 'skipped', reason: 'no_pages' }
  const first = list[0], last = list.length > 1 ? list[list.length - 1] : null
  const contentSha256 = contentHash(list.map((p) => p.text))

  const system = buildClassifySystem(company)
  const prompt = buildClassifyPrompt({ fileName: row.file_name, pageCount: row.page_count, firstPage: first.text, lastPage: last?.text ?? null })
  let classification: Classification
  let model = ''
  try {
    const result = await getAiService().generateStructured({
      tier: 'cheap',
      system,
      prompt,
      maxTokens: 800,
      schema: { name: 'classify_document', description: 'The classification of one document.', jsonSchema: CLASSIFICATION_JSON_SCHEMA },
    })
    model = result.model
    const parsed = Classification.safeParse(result.value)
    if (!parsed.success) return { status: 'error', reason: `classification did not match schema: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}` }
    classification = parsed.data
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.warn('classify failed', { doc: documentId, reason })
    return { status: 'error', reason: reason.slice(0, 300) }
  }

  const admission: 'admitted' | 'held' = classification.relevance === 'relevant' ? 'admitted' : 'held'
  const signals = await authenticitySignals(supabase, row, classification, list, contentSha256)
  return persistClassification(supabase, row, classification, { model, promptSha256: sha256(system + '\n' + prompt), decidedBy: 'model', admission, signals, contentSha256 })
}

/**
 * Phase 6: what a person should know before trusting the file. Not a verdict:
 * a scan without a text layer is normal for a photographed receipt, a
 * duplicate is often the same invoice sent twice, a bundle needs splitting.
 */
export type AuthenticitySignal = 'no_text_layer' | 'duplicate_content' | 'multi_document'

async function authenticitySignals(
  supabase: SupabaseClient,
  doc: DocumentRow,
  c: Classification,
  pages: Array<{ reader: string; has_text_layer: boolean }>,
  contentSha256: string | null,
): Promise<AuthenticitySignal[]> {
  const signals: AuthenticitySignal[] = []
  if (pages.length > 0 && pages.every((p) => p.reader === 'claude_vision' && !p.has_text_layer)) signals.push('no_text_layer')
  if (c.is_multi_document) signals.push('multi_document')
  if (contentSha256) {
    const { data, error } = await supabase
      .from('document_classifications')
      .select('document_id')
      .eq('company_id', doc.company_id)
      .eq('is_current', true)
      .eq('content_sha256', contentSha256)
      .neq('document_id', doc.id)
      .limit(1)
    if (error) log.warn('duplicate check failed', { doc: doc.id, reason: error.message })
    else if ((data ?? []).length > 0) signals.push('duplicate_content')
  }
  return signals
}

/** The page text with whitespace folded, so the same document read twice hashes the same; null when there is nothing to hash. */
export function contentHash(texts: string[]): string | null {
  const folded = texts
    .map((t) => t.toLowerCase().replace(/\s+/g, ' ').trim())
    .join('\n')
    .trim()
  return folded.length >= 40 ? sha256(folded) : null
}

/** A person's verdict on type or relevance: the current classification from now on, never overridden by the model. */
export async function recordHumanClassification(
  supabase: SupabaseClient,
  documentId: string,
  userId: string,
  decision: { docType: DocType; relevance: 'relevant' | 'ask'; reason?: string },
): Promise<ClassifyOutcome> {
  const { data: doc, error } = await supabase
    .from('document_attachments')
    .select('id, company_id, user_id, file_name, page_count, admission_state')
    .eq('id', documentId)
    .maybeSingle()
  if (error) return { status: 'error', reason: `document fetch failed: ${error.message}` }
  if (!doc) return { status: 'skipped', reason: 'not_found' }
  const { data: current } = await supabase
    .from('document_classifications')
    .select('summary, language, addressed_to, is_multi_document, signals, content_sha256')
    .eq('document_id', documentId)
    .eq('is_current', true)
    .maybeSingle()
  const prev = (current ?? {}) as Partial<Classification>
  const classification: Classification = {
    doc_type: decision.docType,
    confidence: 1,
    language: prev.language ?? null,
    is_multi_document: prev.is_multi_document ?? false,
    relevance: decision.relevance,
    relevance_reason: decision.reason ?? '',
    addressed_to: prev.addressed_to ?? null,
    summary: prev.summary ?? '',
    suggested_type: null,
  }
  return persistClassification(supabase, doc as DocumentRow, classification, { model: null, promptSha256: null, decidedBy: 'human', userId, admission: decision.relevance === 'relevant' ? 'admitted' : 'held' })
}

async function persistClassification(
  supabase: SupabaseClient,
  doc: DocumentRow,
  c: Classification,
  meta: { model: string | null; promptSha256: string | null; decidedBy: 'model' | 'human'; userId?: string; admission: 'admitted' | 'held'; signals?: AuthenticitySignal[]; contentSha256?: string | null },
): Promise<ClassifyOutcome> {
  const { error: retireError } = await supabase.from('document_classifications').update({ is_current: false }).eq('document_id', doc.id).eq('is_current', true)
  if (retireError) return { status: 'error', reason: `retire failed: ${retireError.message}` }
  const { error: insertError } = await supabase.from('document_classifications').insert({
    company_id: doc.company_id,
    document_id: doc.id,
    doc_type: c.doc_type,
    confidence: c.confidence,
    language: c.language,
    is_multi_document: c.is_multi_document,
    relevance: c.relevance,
    relevance_reason: c.relevance_reason,
    addressed_to: c.addressed_to,
    summary: c.summary,
    suggested_type: c.suggested_type,
    model: meta.model,
    prompt_sha256: meta.promptSha256,
    decided_by: meta.decidedBy,
    decided_by_user_id: meta.userId ?? null,
    signals: meta.signals ?? [],
    content_sha256: meta.contentSha256 ?? null,
    is_current: true,
  })
  if (insertError) return { status: 'error', reason: `insert failed: ${insertError.message}` }
  // A document a person already admitted is never put back on hold by the model.
  const admission = meta.decidedBy === 'model' && doc.admission_state === 'admitted' ? 'admitted' : meta.admission
  const update: Record<string, unknown> = { doc_type: c.doc_type, admission_state: admission }
  if (admission === 'admitted' && doc.admission_state !== 'admitted') update.admitted_at = new Date().toISOString()
  if (meta.decidedBy === 'human' && meta.admission === 'admitted') update.admission_reason = c.relevance_reason || null
  const { error: docError } = await supabase.from('document_attachments').update(update).eq('id', doc.id)
  if (docError) return { status: 'error', reason: `document update failed: ${docError.message}` }
  // What it is decides where it goes: the inbox extension queues or releases it on this.
  await eventBus.emit({
    type: 'document.classified',
    payload: { document: { id: doc.id, file_name: doc.file_name }, companyId: doc.company_id, userId: meta.userId ?? doc.user_id ?? '', docType: c.doc_type, admission, decidedBy: meta.decidedBy },
  })
  captureArkivEvent('arkiv_document_landed', { companyId: doc.company_id, userId: meta.userId ?? doc.user_id ?? null, doc_type: c.doc_type, admission, decided_by: meta.decidedBy })
  return { status: 'classified', classification: c, admission }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Company identity for the prompt: name and organisation number from the companies row. */
export async function loadCompanyIdentity(supabase: SupabaseClient, companyId: string): Promise<CompanyIdentity> {
  const { data } = await supabase.from('companies').select('name, org_number').eq('id', companyId).maybeSingle()
  const row = (data ?? {}) as { name?: string; org_number?: string | null }
  return { name: row.name ?? 'the company', orgNumber: row.org_number ?? null }
}

/** Backfill: classify documents that have pages but no current classification, newest first. */
export async function classifyUnclassifiedDocuments(
  supabase: SupabaseClient,
  companyId: string,
  limit: number,
): Promise<{ processed: number; classified: number; held: number; skipped: number; errors: number }> {
  const counts = { processed: 0, classified: 0, held: 0, skipped: 0, errors: 0 }
  const { data, error } = await supabase
    .from('document_attachments')
    .select('id')
    .eq('company_id', companyId)
    .is('doc_type', null)
    .not('pages_read_at', 'is', null)
    .gt('page_count', 0)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`fetch unclassified failed: ${error.message}`)
  const company = await loadCompanyIdentity(supabase, companyId)
  for (const row of (data ?? []) as Array<{ id: string }>) {
    const out = await classifyDocument(supabase, row.id, company)
    counts.processed++
    if (out.status === 'classified') { counts.classified++; if (out.admission === 'held') counts.held++ }
    else if (out.status === 'skipped') counts.skipped++
    else counts.errors++
  }
  return counts
}
