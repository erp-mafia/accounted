import type { FindingKind } from '@/lib/arkiv/lint/checks'
import { isDocType, type DocType } from '@/lib/documents/classify/taxonomy'
import type { Reading } from '@/lib/documents/extract/fields'

/**
 * Arkiv phase 9d: the questions Arkiv has for a person, as one list with
 * one shape, so Granska and Underlag ask the same way: a sentence with the
 * answer we would give, one tap, and what happens next. The review route
 * serves the raw material; this turns it into questions. Pure, so both
 * pages and the tests share it.
 */
export interface ReviewDocument {
  document_id: string
  file_name: string
  title: string
  created_at: string
  page_count: number | null
  doc_type: string | null
  confidence: number | null
  relevance: string | null
  relevance_reason: string | null
  addressed_to: string | null
  summary: string | null
  suggested_type: string | null
}

export interface FieldQuestion {
  field: string
  /** The check that failed, when one did; else the two readings disagreed. */
  check: string | null
  readings: Reading[]
}

export interface FieldReviewDocument {
  document_id: string
  file_name: string
  title: string
  created_at: string
  page_count: number | null
  doc_type: string | null
  schema_type: string
  review_fields: string[]
  questions: FieldQuestion[]
}

export interface ReviewData {
  held: ReviewDocument[]
  unclassified: ReviewDocument[]
  fields: FieldReviewDocument[]
}

/** What a finding question needs of a finding: the route's FindingView satisfies it. */
export interface QuestionFinding {
  finding_id: string
  kind: FindingKind
  subject_id: string | null
  detail: Record<string, unknown>
}

export type ArkivQuestion =
  | { id: string; kind: 'held'; document: ReviewDocument }
  | { id: string; kind: 'type'; document: ReviewDocument; proposed: DocType | null }
  | { id: string; kind: 'field'; document: FieldReviewDocument; field: string; check: string | null; readings: Reading[]; remaining: number }
  | { id: string; kind: 'finding'; finding: QuestionFinding }

/** The type one tap would save: the model's suggestion when it is a real type, else its own unsure type, never "other". */
export function proposedType(doc: Pick<ReviewDocument, 'doc_type' | 'suggested_type'>): DocType | null {
  if (isDocType(doc.suggested_type) && doc.suggested_type !== 'other') return doc.suggested_type
  if (isDocType(doc.doc_type) && doc.doc_type !== 'other') return doc.doc_type
  return null
}

/** The readings worth a chip: one per distinct value, first page kept, empties dropped. */
export function distinctReadings(readings: Reading[]): Reading[] {
  const seen = new Set<string>()
  const out: Reading[] = []
  for (const r of readings) {
    if (r.value == null) continue
    const key = String(r.value).trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

export function questionsFrom(review: ReviewData | null, findings: QuestionFinding[] | null): ArkivQuestion[] {
  const out: ArkivQuestion[] = []
  for (const d of review?.held ?? []) out.push({ id: `held:${d.document_id}`, kind: 'held', document: d })
  for (const d of review?.unclassified ?? []) out.push({ id: `type:${d.document_id}`, kind: 'type', document: d, proposed: proposedType(d) })
  for (const d of review?.fields ?? []) {
    // One question per document at a time: the first field with something to choose between or a failed check, else the first field.
    const first = d.questions.find((q) => q.check || distinctReadings(q.readings).length > 0) ?? d.questions[0]
    if (!first) continue
    out.push({
      id: `field:${d.document_id}:${first.field}`,
      kind: 'field',
      document: d,
      field: first.field,
      check: first.check,
      readings: distinctReadings(first.readings),
      remaining: Math.max(0, d.review_fields.length - 1),
    })
  }
  for (const f of findings ?? []) out.push({ id: `finding:${f.finding_id}`, kind: 'finding', finding: f })
  return out
}

/** The question about one document, for a page that shows that document. */
export function questionForDocument(questions: ArkivQuestion[], documentId: string): ArkivQuestion | null {
  return questions.find((q) => q.kind !== 'finding' && q.document.document_id === documentId) ?? null
}
