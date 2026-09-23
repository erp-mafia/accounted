import { describe, it, expect } from 'vitest'
import { distinctReadings, proposedType, questionForDocument, questionsFrom, type FieldReviewDocument, type ReviewDocument } from '../questions'

const doc = (over: Partial<ReviewDocument> = {}): ReviewDocument => ({
  document_id: 'd1',
  file_name: 'IMG_1.jpg',
  title: 'IMG_1',
  created_at: '2026-09-17T10:00:00Z',
  page_count: 1,
  doc_type: 'other',
  confidence: 0.4,
  relevance: 'ask',
  relevance_reason: 'Ingen koppling till bolaget.',
  addressed_to: null,
  summary: 'Ett foto.',
  suggested_type: null,
  ...over,
})

const fieldDoc = (over: Partial<FieldReviewDocument> = {}): FieldReviewDocument => ({
  document_id: 'f1',
  file_name: 'hyresavtal.pdf',
  title: 'Hyresavtal Kvarnen AB',
  created_at: '2026-09-17T10:00:00Z',
  page_count: 4,
  doc_type: 'agreement.rental',
  schema_type: 'agreement.rental',
  review_fields: ['monthly_rent', 'ends_on'],
  questions: [
    { field: 'monthly_rent', check: null, readings: [{ value: 12500, page: 2, quote: 'Hyran 12 500' }, { value: '12500', page: 3, quote: null }, { value: 15000, page: 2, quote: 'moms 15 000' }] },
    { field: 'ends_on', check: 'date_order', readings: [] },
  ],
  ...over,
})

describe('questionsFrom', () => {
  it('asks the door, the type, one field per document, then the findings, in that order', () => {
    const qs = questionsFrom(
      { held: [doc()], unclassified: [doc({ document_id: 'd2', relevance: 'relevant', suggested_type: 'agreement.rental' })], fields: [fieldDoc()] },
      [{ finding_id: 'x1', kind: 'agreement_ending', subject_id: 'a1', detail: {} }],
    )
    expect(qs.map((q) => [q.kind, q.id])).toEqual([
      ['held', 'held:d1'],
      ['type', 'type:d2'],
      ['field', 'field:f1:monthly_rent'],
      ['finding', 'finding:x1'],
    ])
    const field = qs[2]
    if (field.kind !== 'field') throw new Error('expected a field question')
    // Three readings, two distinct values: one chip each, the page of the first kept; one field left for the sheet.
    expect(field.readings).toEqual([
      { value: 12500, page: 2, quote: 'Hyran 12 500' },
      { value: 15000, page: 2, quote: 'moms 15 000' },
    ])
    expect(field.remaining).toBe(1)
  })

  it('prefers a field with something to choose or a failed check over one with nothing to show', () => {
    const qs = questionsFrom({ held: [], unclassified: [], fields: [fieldDoc({ questions: [{ field: 'a', check: null, readings: [{ value: null, page: null, quote: null }] }, { field: 'b', check: 'required', readings: [] }] })] }, null)
    expect(qs).toHaveLength(1)
    expect(qs[0]).toMatchObject({ kind: 'field', field: 'b', check: 'required', readings: [], remaining: 1 })
  })

  it('handles nothing loaded and a document with no questions', () => {
    expect(questionsFrom(null, null)).toEqual([])
    expect(questionsFrom({ held: [], unclassified: [], fields: [fieldDoc({ questions: [], review_fields: [] })] }, [])).toEqual([])
  })

  it('finds the question about one document, never a finding', () => {
    const qs = questionsFrom({ held: [doc()], unclassified: [], fields: [fieldDoc()] }, [{ finding_id: 'x1', kind: 'duplicate_document', subject_id: 'f1', detail: {} }])
    expect(questionForDocument(qs, 'f1')?.id).toBe('field:f1:monthly_rent')
    expect(questionForDocument(qs, 'd1')?.id).toBe('held:d1')
    expect(questionForDocument(qs, 'nope')).toBeNull()
  })
})

describe('proposedType', () => {
  it('takes the suggestion when it is a real type, else the unsure type, never other', () => {
    expect(proposedType({ doc_type: 'other', suggested_type: 'agreement.rental' })).toBe('agreement.rental')
    expect(proposedType({ doc_type: 'receipt', suggested_type: 'intyg' })).toBe('receipt')
    expect(proposedType({ doc_type: 'other', suggested_type: 'other' })).toBeNull()
    expect(proposedType({ doc_type: null, suggested_type: null })).toBeNull()
  })
})

describe('distinctReadings', () => {
  it('drops empties and repeats, case and space blind', () => {
    expect(distinctReadings([{ value: ' Kvarnen AB ', page: 1, quote: null }, { value: 'kvarnen ab', page: 2, quote: null }, { value: '', page: 3, quote: null }, { value: null, page: null, quote: null }])).toEqual([{ value: ' Kvarnen AB ', page: 1, quote: null }])
  })
})
