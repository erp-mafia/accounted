import { describe, expect, it } from 'vitest'
import { WORKLIST_CATEGORIES, type WorklistCategory } from '@/lib/worklist/types'
import { countRowSpecs, type CountRowInput } from '../need-rows'
import { NEED_GROUPS } from '../need-model'

const zero = () => Object.fromEntries(WORKLIST_CATEGORIES.map((c) => [c, 0])) as Record<WorklistCategory, number>
const input = (counts: Partial<Record<WorklistCategory, number>>, extra: Partial<CountRowInput> = {}): CountRowInput => ({
  counts: { ...zero(), ...counts },
  hasAi: true,
  inboxHref: '/inkorg',
  invoiceSetRows: 0,
  personAttestRows: 0,
  ...extra,
})
const keys = (i: CountRowInput) => countRowSpecs(i).map((s) => s.key)
const spec = (i: CountRowInput, key: string) => countRowSpecs(i).find((s) => s.key === key)

describe('countRowSpecs: with the booking screen switched on', () => {
  const on = (counts: Partial<Record<WorklistCategory, number>>, extra: Partial<CountRowInput> = {}) => input(counts, { bookingScreen: true, ...extra })

  it('folds the bank rows and the inbox documents into one Att bokföra row', () => {
    const specs = countRowSpecs(on({ book_transaction: 498, inbox_document: 43 }))
    expect(specs.map((s) => s.key)).toEqual(['to-book'])
    expect(specs[0]).toMatchObject({ href: '/att-bokfora', labelKey: 'row_to_book', items: 'to_book', group: 'book', count: 541, things: 541 })
  })

  it('counts only the bank rows where documents are not read', () => {
    expect(spec(on({ book_transaction: 5, inbox_document: 9 }, { hasAi: false }), 'to-book')).toMatchObject({ count: 5 })
  })

  it('counts the skattekonto events in the same row', () => {
    const specs = countRowSpecs(on({ book_transaction: 498, book_skattekonto: 4, inbox_document: 43 }))
    expect(specs.map((s) => s.key)).toEqual(['to-book'])
    expect(specs[0]).toMatchObject({ count: 545, things: 545 })
  })

  it('keeps the suggested matches where they were', () => {
    const hrefs = Object.fromEntries(countRowSpecs(on({ suggested_match: 3 })).map((s) => [s.key, s.href]))
    expect(hrefs).toEqual({ 'suggested-matches': '/transactions' })
  })
})

describe('countRowSpecs: which count rows Att göra has', () => {
  it('has none when every count is zero', () => {
    expect(countRowSpecs(input({}))).toEqual([])
  })

  it('one count gives one row, counted as that many things, leading to its page', () => {
    expect(countRowSpecs(input({ book_transaction: 240 }))).toEqual([
      { key: 'book-transactions', items: 'bank_rows', earliest: 'oldest', group: 'book', href: '/transactions?view=inbox', labelKey: 'row_book_transactions', category: 'book_transaction', count: 240, things: 240 },
    ])
    expect(spec(input({ verifikat_missing_document: 1 }), 'missing-underlag')).toMatchObject({ group: 'upload', count: 1, things: 1, href: '/bookkeeping?missingUnderlag=true' })
    expect(spec(input({ verifikat_missing_document: 583 }), 'missing-underlag')).toMatchObject({ count: 583, things: 1 })
  })

  it('keeps every deep link the list has carried', () => {
    const all = input(Object.fromEntries(WORKLIST_CATEGORIES.map((c) => [c, 3])) as Record<WorklistCategory, number>)
    expect(Object.fromEntries(countRowSpecs(all).map((s) => [s.key, s.href]))).toEqual({
      'supplier-approval': '/supplier-invoices?tab=registered',
      'book-transactions': '/transactions?view=inbox',
      'book-skattekonto': '/transactions?source=skatteverket&view=inbox',
      'suggested-matches': '/transactions',
      'inbox-documents': '/inkorg',
      'collection-settlements': '/invoices/settlements',
      'collected-payments': '/invoices/settlements',
      'collection-decision': '/invoices?status=collections',
      'document-relevance': '/arkiv',
      'document-unclassified': '/arkiv/granska#typ',
      'document-field-review': '/arkiv/granska#falt',
      'arkiv-finding': '/arkiv/granska#fynd',
      'peppol-failed': '/invoices',
      'collection-attention': '/invoices?status=collections',
      'missing-underlag': '/bookkeeping?missingUnderlag=true',
      deadlines: '/deadlines',
      'agreement-missed': '/arkiv/avtal',
      'reconciliation-due': '/reconciliation',
    })
  })

  it('comes out in group order, every row in a known group', () => {
    const all = input(Object.fromEntries(WORKLIST_CATEGORIES.map((c) => [c, 2])) as Record<WorklistCategory, number>)
    const order = countRowSpecs(all).map((s) => NEED_GROUPS.indexOf(s.group))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('hides the inbox row without the paid surface', () => {
    expect(keys(input({ inbox_document: 4 }))).toEqual(['inbox-documents'])
    expect(keys(input({ inbox_document: 4 }, { hasAi: false }))).toEqual([])
  })

  it('the inbox row leads where the company has its inbox', () => {
    expect(spec(input({ inbox_document: 1 }, { inboxHref: '/e/general/invoice-inbox' }), 'inbox-documents')?.href).toBe('/e/general/invoice-inbox')
  })

  it('suggested matches: less the several-invoice rows, and never counted twice', () => {
    expect(spec(input({ suggested_match: 5, book_transaction: 9 }), 'suggested-matches')).toMatchObject({ count: 5, things: 0 })
    expect(spec(input({ suggested_match: 5 }, { invoiceSetRows: 2 }), 'suggested-matches')).toMatchObject({ count: 3, things: 0 })
    expect(spec(input({ suggested_match: 2 }, { invoiceSetRows: 2 }), 'suggested-matches')).toBeUndefined()
    expect(spec(input({ suggested_match: 1 }, { invoiceSetRows: 4 }), 'suggested-matches')).toBeUndefined()
  })

  it('the company attest row counts only what the person rows do not show', () => {
    expect(spec(input({ supplier_invoice_approval: 5 }), 'supplier-approval')).toMatchObject({ count: 5, things: 5 })
    expect(spec(input({ supplier_invoice_approval: 5 }, { personAttestRows: 2 }), 'supplier-approval')).toMatchObject({ count: 3, things: 3 })
    expect(spec(input({ supplier_invoice_approval: 2 }, { personAttestRows: 2 }), 'supplier-approval')).toBeUndefined()
  })

  it('the question list is one row that opens the list, one thing whatever the number of questions', () => {
    expect(keys(input({}))).toEqual([])
    expect(keys(input({}, { openQuestions: 0 }))).toEqual([])
    expect(countRowSpecs(input({}, { openQuestions: 3 }))).toEqual([
      { key: 'company-questions', group: 'decide', href: '/questions', labelKey: 'row_company_questions', count: 3, things: 1 },
    ])
    expect(spec(input({}, { openQuestions: 1 }), 'company-questions')).toMatchObject({ count: 1, things: 1 })
  })

  it('leaves the rows that are not plain counts to the section (pending operations, batches, payments)', () => {
    const all = input(Object.fromEntries(WORKLIST_CATEGORIES.map((c) => [c, 1])) as Record<WorklistCategory, number>)
    const categories = new Set(countRowSpecs(all).map((s) => s.category))
    for (const c of ['pending_operations', 'collection_batch_ready', 'reminder_batch_ready', 'attested_to_pay', 'payments_to_sign', 'overdue_invoice', 'suggestion'] as const) {
      expect(categories.has(c)).toBe(false)
    }
  })
})
