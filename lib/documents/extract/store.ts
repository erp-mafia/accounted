import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAiStatus } from '@/lib/ai'
import type { CompanyIdentity } from '@/lib/documents/classify/classify'
import { humanAgent, recordActivity, softwareAgent } from '@/lib/documents/provenance'
import type { WordBox } from '@/lib/documents/read/types'
import { EXTRACTOR, readFields } from './extract'
import { normalizeValue, type ExtractedField, type Payload } from './fields'
import type { PageText } from './locate'
import { runChecks, type CheckFailure } from './merge'
import { fieldKinds, jsonSchemaFor, schemaForType, type ExtractionSchemaDef } from './schemas'
import { auditOneIn } from '@/lib/arkiv/lint/autonomy'

/**
 * Arkiv phase 3: the stored record of a document. A model run writes a
 * consensus row; a person settling fields writes a human row on top of it.
 * Both go through save_document_extraction, which supersedes the current row
 * in one transaction and refuses when it changed since it was read.
 */
export type SkipReason =
  | 'ai_unconfigured'
  | 'not_found'
  | 'not_admitted'
  | 'no_type'
  | 'no_text'
  | 'up_to_date'
  | 'no_extraction'
  | 'unknown_fields'

export type ExtractOutcome =
  | { status: 'extracted'; extractionId: string; schemaType: string; reviewFields: string[] }
  | { status: 'skipped'; reason: SkipReason }
  | { status: 'error'; reason: string }

interface DocumentRow {
  id: string
  company_id: string
  file_name: string
  doc_type: string | null
  admission_state: 'held' | 'admitted'
}

interface CurrentExtraction {
  id: string
  schema_type: string
  schema_version: number
  pass: 'consensus' | 'human'
  payload: Payload
  validation: CheckFailure[]
  review_fields: string[]
}

interface NewExtraction {
  schemaType: string
  schemaVersion: number
  activityId: string
  supersedesId: string | null
  pass: 'consensus' | 'human'
  payload: Payload
  checks: CheckFailure[]
  reviewFields: string[]
}

export async function extractDocument(supabase: SupabaseClient, documentId: string, company: CompanyIdentity): Promise<ExtractOutcome> {
  if (!getAiStatus().configured) return skip('ai_unconfigured')
  try {
    const doc = await loadDocument(supabase, documentId)
    if (!doc) return skip('not_found')
    if (doc.admission_state !== 'admitted') return skip('not_admitted')
    if (!doc.doc_type) return skip('no_type')
    const def = schemaForType(doc.doc_type)
    const current = await loadCurrentExtraction(supabase, documentId)
    // For the same schema a person's record stands, and a model's record stands until the schema version moves.
    if (current?.schema_type === def.schemaType && (current.pass === 'human' || current.schema_version === def.version)) return skip('up_to_date')
    const pages = await loadPages(supabase, documentId)
    if (!pages.some((p) => p.text.trim())) return skip('no_text')

    const startedAt = new Date().toISOString()
    const run = await readFields({ def, company, fileName: doc.file_name, pages })
    const audit = auditSample(documentId, def, run.reviewFields, auditOneIn(await autonomyLevel(supabase, doc.company_id, def.schemaType)))
    if (audit) {
      run.reviewFields.push(audit)
      run.checks.push({ check: 'audit', field: audit })
    }
    await registerSchema(supabase, def)
    const activityId = await recordActivity(supabase, {
      companyId: doc.company_id,
      documentId,
      agentId: await softwareAgent(supabase, EXTRACTOR.name, EXTRACTOR.version),
      kind: 'extract',
      schemaType: def.schemaType,
      schemaVersion: def.version,
      modelIds: run.modelIds,
      promptSha256: run.promptSha256,
      startedAt,
      outcome: run.reviewFields.length ? 'review' : 'settled',
      detail: { pages_sent: run.pagesSent },
    })
    return await saveExtraction(supabase, documentId, {
      schemaType: def.schemaType,
      schemaVersion: def.version,
      activityId,
      supersedesId: current?.id ?? null,
      pass: 'consensus',
      payload: run.payload,
      checks: run.checks,
      reviewFields: run.reviewFields,
    })
  } catch (err) {
    return failure(err)
  }
}

/**
 * A person settles fields of the current record. The settled fields carry the
 * person's value with full confidence and leave the review list, even when a
 * check still objects (the failure stays in validation for anyone to see).
 */
export async function recordHumanFields(
  supabase: SupabaseClient,
  documentId: string,
  userId: string,
  values: Record<string, string | number | null>,
): Promise<ExtractOutcome> {
  try {
    const doc = await loadDocument(supabase, documentId)
    if (!doc) return skip('not_found')
    const current = await loadCurrentExtraction(supabase, documentId)
    if (!current) return skip('no_extraction')
    const def = schemaForType(current.schema_type)
    const kinds = fieldKinds(def)
    const settled = Object.keys(values)
    if (settled.some((name) => !(name in kinds))) return skip('unknown_fields')

    const payload: Payload = { ...current.payload }
    for (const name of settled) {
      const previous: ExtractedField | undefined = current.payload[name]
      payload[name] = {
        value: values[name],
        normalized: normalizeValue(kinds[name], values[name]),
        page: previous?.page ?? null,
        quote: previous?.quote ?? null,
        bbox: previous?.bbox ?? null,
        confidence: 1,
        method: 'human',
        readings: previous?.readings ?? [],
      }
    }
    const checks = runChecks(def, payload)
    const reviewFields = [...new Set([...current.review_fields, ...checks.map((c) => c.field)])].filter((name) => !settled.includes(name))
    // An audited field the person confirmed as read, or changed, is what the autonomy ladder counts.
    const audited = (current.validation ?? []).find((c) => c.check === 'audit' && settled.includes(c.field))
    const audit = audited ? { field: audited.field, changed: normalizeValue(kinds[audited.field], values[audited.field]) !== (current.payload[audited.field]?.normalized ?? null) } : null
    const activityId = await recordActivity(supabase, {
      companyId: doc.company_id,
      documentId,
      agentId: await humanAgent(supabase, userId),
      kind: 'review',
      schemaType: current.schema_type,
      schemaVersion: current.schema_version,
      outcome: reviewFields.length ? 'review' : 'settled',
      detail: audit ? { fields: settled, audit } : { fields: settled },
    })
    return await saveExtraction(supabase, documentId, {
      schemaType: current.schema_type,
      schemaVersion: current.schema_version,
      activityId,
      supersedesId: current.id,
      pass: 'human',
      payload,
      checks,
      reviewFields,
    })
  } catch (err) {
    return failure(err)
  }
}

async function loadDocument(supabase: SupabaseClient, documentId: string): Promise<DocumentRow | null> {
  const { data, error } = await supabase
    .from('document_attachments')
    .select('id, company_id, file_name, doc_type, admission_state')
    .eq('id', documentId)
    .maybeSingle()
  if (error) throw new Error(`document fetch failed: ${error.message}`)
  return data as DocumentRow | null
}

async function loadCurrentExtraction(supabase: SupabaseClient, documentId: string): Promise<CurrentExtraction | null> {
  const { data, error } = await supabase
    .from('document_extractions')
    .select('id, schema_type, schema_version, pass, payload, validation, review_fields')
    .eq('document_id', documentId)
    .eq('is_current', true)
    .maybeSingle()
  if (error) throw new Error(`extraction fetch failed: ${error.message}`)
  return data as CurrentExtraction | null
}

async function loadPages(supabase: SupabaseClient, documentId: string): Promise<PageText[]> {
  const { data, error } = await supabase
    .from('document_pages')
    .select('page_no, text, words')
    .eq('document_id', documentId)
    .order('page_no', { ascending: true })
  if (error) throw new Error(`pages fetch failed: ${error.message}`)
  return ((data ?? []) as Array<{ page_no: number; text: string; words: WordBox[] | null }>).map((p) => ({ pageNo: p.page_no, text: p.text, words: p.words }))
}

async function registerSchema(supabase: SupabaseClient, def: ExtractionSchemaDef): Promise<void> {
  const { error } = await supabase
    .from('extraction_schemas')
    .upsert(
      { schema_type: def.schemaType, version: def.version, json_schema: jsonSchemaFor(def), field_kinds: fieldKinds(def) },
      { onConflict: 'schema_type,version', ignoreDuplicates: true },
    )
  if (error) throw new Error(`schema register failed: ${error.message}`)
}

async function saveExtraction(supabase: SupabaseClient, documentId: string, row: NewExtraction): Promise<ExtractOutcome> {
  const { data, error } = await supabase.rpc('save_document_extraction', {
    p_document_id: documentId,
    p_supersedes_id: row.supersedesId,
    p_activity_id: row.activityId,
    p_schema_type: row.schemaType,
    p_schema_version: row.schemaVersion,
    p_pass: row.pass,
    p_payload: row.payload,
    p_validation: row.checks,
    p_review_fields: row.reviewFields,
  })
  if (error) throw new Error(`extraction save failed: ${error.message}`)
  return { status: 'extracted', extractionId: data as string, schemaType: row.schemaType, reviewFields: row.reviewFields }
}

/** Sample every twentieth settled record (5 %) until a type earns less: its most important field goes to a person, so auto-settled fields are measured, not trusted. */
export const AUDIT_ONE_IN = 20

export function auditSample(documentId: string, def: ExtractionSchemaDef, reviewFields: string[], oneIn: number = AUDIT_ONE_IN): string | null {
  if (reviewFields.length > 0) return null
  const bucket = parseInt(createHash('sha256').update(documentId).digest('hex').slice(0, 8), 16) % Math.max(1, oneIn)
  if (bucket !== 0) return null
  return (def.fields.find((f) => f.required) ?? def.fields[0])?.name ?? null
}

/** The company's earned level for a document type (phase 6); 0 until the nightly lint has counted enough audits. */
async function autonomyLevel(supabase: SupabaseClient, companyId: string, schemaType: string): Promise<number> {
  const { data, error } = await supabase.from('arkiv_autonomy').select('level').eq('company_id', companyId).eq('schema_type', schemaType).maybeSingle()
  if (error) throw new Error(`autonomy fetch failed: ${error.message}`)
  return (data as { level: number } | null)?.level ?? 0
}

const skip = (reason: SkipReason): ExtractOutcome => ({ status: 'skipped', reason })

const failure = (err: unknown): ExtractOutcome => ({ status: 'error', reason: (err instanceof Error ? err.message : String(err)).slice(0, 300) })
