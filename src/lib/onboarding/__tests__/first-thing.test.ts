import { describe, expect, it } from 'vitest'
import { WORKLIST_CATEGORIES } from '@/lib/worklist/types'
import type { WorklistCounts } from '@/lib/worklist/types'
import { isNewCompany, pickFirstThing, type FirstThingInput } from '../first-thing'

function counts(over: Partial<WorklistCounts['counts']> = {}): WorklistCounts['counts'] {
  const base = Object.fromEntries(WORKLIST_CATEGORIES.map((c) => [c, 0])) as WorklistCounts['counts']
  return { ...base, ...over }
}

function input(over: Partial<FirstThingInput> = {}): FirstThingInput {
  return {
    inRollout: true,
    counts: counts(),
    hasBankFeed: true,
    hasImportedBooks: false,
    hasTransactions: true,
    hasAi: true,
    companyCreatedAt: '2026-11-10T08:00:00Z',
    today: '2026-11-25',
    closed: false,
    ...over,
  }
}

describe('pickFirstThing: when it shows nothing', () => {
  it('is null outside the rollout', () => {
    expect(pickFirstThing(input({ inRollout: false, counts: counts({ book_transaction: 4 }) }))).toBeNull()
  })

  it('is null when the person closed the block', () => {
    expect(pickFirstThing(input({ closed: true, counts: counts({ book_transaction: 4 }) }))).toBeNull()
  })

  it('is null for a company older than 30 days', () => {
    expect(
      pickFirstThing(input({ companyCreatedAt: '2026-10-25T00:00:00Z', counts: counts({ book_transaction: 4 }) })),
    ).toBeNull()
  })

  it('still shows on day 30', () => {
    expect(
      pickFirstThing(input({ companyCreatedAt: '2026-10-26T00:00:00Z', counts: counts({ book_transaction: 4 }) }))?.kind,
    ).toBe('book_bank_rows')
  })

  it('is null without a creation date', () => {
    expect(pickFirstThing(input({ companyCreatedAt: null, counts: counts({ book_transaction: 4 }) }))).toBeNull()
  })

  it('is null when connected and nothing below applies', () => {
    expect(pickFirstThing(input({ counts: counts({ overdue_invoice: 2, deadline_action: 1 }) }))).toBeNull()
  })
})

describe('pickFirstThing: the first thing', () => {
  it('a: connect the bank when nothing is connected', () => {
    const r = pickFirstThing(input({ hasBankFeed: false, hasTransactions: false, hasImportedBooks: false }))
    expect(r?.kind).toBe('connect_bank')
    expect(r?.lead).toBe('nothing')
  })

  it('a wins over waiting rows when nothing is connected', () => {
    const r = pickFirstThing(
      input({ hasBankFeed: false, hasTransactions: false, counts: counts({ book_transaction: 3 }) }),
    )
    expect(r?.kind).toBe('connect_bank')
  })

  it('imported books count as connected', () => {
    const r = pickFirstThing(
      input({ hasBankFeed: false, hasTransactions: false, hasImportedBooks: true, counts: counts({ book_transaction: 1 }) }),
    )
    expect(r?.kind).toBe('book_bank_rows')
    expect(r?.lead).toBe('books')
  })

  it('any transactions count as connected', () => {
    const r = pickFirstThing(input({ hasBankFeed: false, hasTransactions: true, counts: counts({ book_transaction: 1 }) }))
    expect(r?.kind).toBe('book_bank_rows')
  })

  it('b: book the bank rows before missing receipts and documents', () => {
    const r = pickFirstThing(
      input({ counts: counts({ book_transaction: 5, verifikat_missing_document: 2, inbox_document: 1 }) }),
    )
    expect(r?.kind).toBe('book_bank_rows')
  })

  it('c: find the missing receipts before documents', () => {
    const r = pickFirstThing(input({ counts: counts({ verifikat_missing_document: 2, inbox_document: 1 }) }))
    expect(r?.kind).toBe('find_receipts')
  })

  it('d: go through the documents', () => {
    const r = pickFirstThing(input({ counts: counts({ inbox_document: 3 }) }))
    expect(r?.kind).toBe('go_through_documents')
  })

  it('d needs the AI capability', () => {
    expect(pickFirstThing(input({ hasAi: false, counts: counts({ inbox_document: 3 }) }))).toBeNull()
  })

  it('the lead names books and bank together', () => {
    const r = pickFirstThing(input({ hasImportedBooks: true, counts: counts({ book_transaction: 1 }) }))
    expect(r?.lead).toBe('books_and_bank')
  })

  it('the lead names the bank alone', () => {
    const r = pickFirstThing(input({ counts: counts({ book_transaction: 1 }) }))
    expect(r?.lead).toBe('bank')
  })
})

describe('pickFirstThing: what comes after', () => {
  it('lists the next rows in their order, without the first thing', () => {
    const r = pickFirstThing(
      input({ counts: counts({ book_transaction: 5, inbox_document: 2, verifikat_missing_document: 1, overdue_invoice: 4 }) }),
    )
    expect(r?.after.map((t) => t.category)).toEqual(['inbox_document', 'verifikat_missing_document', 'overdue_invoice'])
    expect(r?.after.find((t) => t.category === 'inbox_document')?.count).toBe(2)
  })

  it('holds at most three', () => {
    const r = pickFirstThing(
      input({
        counts: counts({
          book_transaction: 5,
          book_skattekonto: 1,
          inbox_document: 1,
          supplier_invoice_approval: 1,
          verifikat_missing_document: 1,
          deadline_action: 1,
        }),
      }),
    )
    expect(r?.after).toHaveLength(3)
    expect(r?.after.map((t) => t.category)).toEqual(['book_skattekonto', 'inbox_document', 'supplier_invoice_approval'])
  })

  it('leaves out the inbox row without the AI capability', () => {
    const r = pickFirstThing(input({ hasAi: false, counts: counts({ book_transaction: 1, inbox_document: 2, overdue_invoice: 1 }) }))
    expect(r?.after.map((t) => t.category)).toEqual(['overdue_invoice'])
  })

  it('keeps the rows when the first thing is connecting the bank', () => {
    const r = pickFirstThing(
      input({ hasBankFeed: false, hasTransactions: false, counts: counts({ overdue_invoice: 1 }) }),
    )
    expect(r?.after.map((t) => t.category)).toEqual(['overdue_invoice'])
  })
})

describe('isNewCompany', () => {
  it('reads a date or a timestamp', () => {
    expect(isNewCompany('2026-11-01', '2026-11-25')).toBe(true)
    expect(isNewCompany('2026-10-20T10:00:00Z', '2026-11-25')).toBe(false)
  })

  it('rejects unparseable dates', () => {
    expect(isNewCompany('nope', '2026-11-25')).toBe(false)
  })
})
