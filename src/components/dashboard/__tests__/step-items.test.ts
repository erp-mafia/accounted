import { describe, expect, it } from 'vitest'
import { countRowSpecs } from '../need-rows'
import { inboxFocusHref, inboxStepItem, summarize, type StepItem } from '../StepItems'
import type { InkorgItem } from '@/lib/inkorg/items'
import type { WorklistCategory } from '@/lib/worklist/types'

const item = (id: string, extra: Partial<StepItem> = {}): StepItem => ({ id, name: id, date: null, amount: null, currency: null, href: '/x', ...extra })

describe('summarize: what a step table tells the step', () => {
  it('the earliest date, whatever the order', () => {
    expect(summarize([item('a', { date: '2026-11-15T08:00:00Z' }), item('b', { date: '2026-11-02' })], 9).earliest).toBe('2026-11-02')
  })

  it('no dates: no earliest', () => {
    expect(summarize([item('a')], 1).earliest).toBeNull()
  })

  it('a sum only when every item is listed, has an amount and shares a currency', () => {
    const two = [item('a', { amount: 18500, currency: 'SEK' }), item('b', { amount: 18500.5, currency: 'SEK' })]
    expect(summarize(two, 2).sum).toEqual({ value: 37000.5, currency: 'SEK' })
    expect(summarize(two, 18).sum).toBeNull()
    expect(summarize([...two, item('c')], 3).sum).toBeNull()
    expect(summarize([two[0], item('d', { amount: 10, currency: 'EUR' })], 2).sum).toBeNull()
  })

  it('an empty list has neither', () => {
    expect(summarize([], 0)).toEqual({ earliest: null, sum: null })
  })
})

describe('inbox documents in a step', () => {
  const base: InkorgItem = {
    id: 'i1',
    status: 'received',
    source: 'peppol',
    created_at: '2026-11-15T21:18:00Z',
    channel_context: { intake_source: 'peppol' } as InkorgItem['channel_context'],
    document_id: 'd1',
    extracted_data: null,
    matched_transaction_id: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    email_from: null,
    email_subject: null,
    error_message: null,
  }

  it('says the door it came through and when it came in', () => {
    const row = inboxStepItem(base, '/inkorg')
    expect(row.door).toBe('peppol')
    expect(row.date).toBe('2026-11-15T21:18:00Z')
    expect(row.amount).toBeNull()
    expect(row.currency).toBeNull()
  })

  it('a mail without a reading is named by its sender', () => {
    const row = inboxStepItem({ ...base, source: 'email', channel_context: null, email_from: ' faktura@leverantor.example ' }, '/inkorg')
    expect(row.name).toBe('faktura@leverantor.example')
    expect(row.door).toBe('intake_email')
  })

  it('opens the document in the focus view of Inkommande, and the old inbox as a page', () => {
    expect(inboxFocusHref('/inkorg', 'i1')).toBe('/inkorg?fokus=i1')
    expect(inboxFocusHref('/e/general/invoice-inbox', 'i1')).toBe('/e/general/invoice-inbox')
    // Opened from Att bokföra: the list to return to rides along.
    expect(inboxFocusHref('/inkorg', 'i1', '/att-bokfora?visa=utan-bankrad')).toBe('/inkorg?fokus=i1&tillbaka=%2Fatt-bokfora%3Fvisa%3Dutan-bankrad')
    expect(inboxStepItem(base, '/inkorg').href).toBe('/inkorg?fokus=i1')
  })
})

describe('every count row says what its Börja step lists', () => {
  it('all but the two rows without a single bounded read', () => {
    const categories = [
      'supplier_invoice_approval', 'book_transaction', 'book_skattekonto', 'suggested_match', 'inbox_document',
      'collection_settlements_to_book', 'collected_payments_to_book', 'collection_decision', 'document_relevance',
      'document_unclassified', 'document_field_review', 'arkiv_finding', 'peppol_delivery_failed', 'collection_attention',
      'verifikat_missing_document', 'deadline_action', 'agreement_payment_missed', 'reconciliation_due',
    ]
    const counts = Object.fromEntries(categories.map((c) => [c, 3])) as Record<WorklistCategory, number>
    const specs = countRowSpecs({ counts, hasAi: true, inboxHref: '/inkorg', invoiceSetRows: 0, personAttestRows: 0 })
    expect(specs).toHaveLength(18)
    expect(specs.filter((spec) => !spec.items).map((spec) => spec.key).sort()).toEqual(['arkiv-finding', 'reconciliation-due'])
    expect(specs.find((spec) => spec.key === 'inbox-documents')?.items).toBe('inbox')
  })
})
