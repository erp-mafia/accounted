import { describe, expect, it } from 'vitest'
import { WORKLIST_CATEGORIES } from '@/lib/worklist/types'
import type { WorklistCounts } from '@/lib/worklist/types'
import { createdOnOrAfter, isNewCompany, pickFirstThing, type FirstThingInput } from '../first-thing'

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
    companyCreatedAt: '2026-11-10T08:00:00Z',
    today: '2026-11-25',
    closed: false,
    canWrite: true,
    demoCompany: false,
    bankConnectOffered: true,
    createdFrom: null,
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
    expect(pickFirstThing(input({ counts: counts({ overdue_invoice: 2 }) }))).toBeNull()
  })
})

describe('pickFirstThing: who keeps the usual Hem', () => {
  it('a read-only member', () => {
    expect(pickFirstThing(input({ canWrite: false, counts: counts({ book_transaction: 4 }) }))).toBeNull()
    expect(pickFirstThing(input({ canWrite: false, hasBankFeed: false, hasTransactions: false }))).toBeNull()
  })

  it('the demo company', () => {
    expect(pickFirstThing(input({ demoCompany: true, counts: counts({ book_transaction: 4 }) }))).toBeNull()
    expect(pickFirstThing(input({ demoCompany: true, hasBankFeed: false, hasTransactions: false }))).toBeNull()
  })

  it('a company with a deadline that needs attention, whatever else waits', () => {
    expect(pickFirstThing(input({ counts: counts({ book_transaction: 4, deadline_action: 1 }) }))).toBeNull()
    expect(pickFirstThing(input({ hasBankFeed: false, hasTransactions: false, counts: counts({ deadline_action: 2 }) }))).toBeNull()
  })

  it('a company created before the first day the block applies from', () => {
    const waiting = counts({ book_transaction: 4 })
    expect(pickFirstThing(input({ createdFrom: '2026-11-11', counts: waiting }))).toBeNull()
    expect(pickFirstThing(input({ createdFrom: '2026-11-10', counts: waiting }))?.kind).toBe('book_bank_rows')
    expect(pickFirstThing(input({ createdFrom: '2026-11-01', counts: waiting }))?.kind).toBe('book_bank_rows')
    expect(pickFirstThing(input({ createdFrom: null, counts: waiting }))?.kind).toBe('book_bank_rows')
  })
})

describe('createdOnOrAfter', () => {
  it('compares days, not times', () => {
    expect(createdOnOrAfter('2026-11-26T00:00:01Z', '2026-11-26')).toBe(true)
    expect(createdOnOrAfter('2026-11-25T23:59:59Z', '2026-11-26')).toBe(false)
    expect(createdOnOrAfter('2026-12-01', '2026-11-26')).toBe(true)
  })

  it('is false for a missing or unreadable date', () => {
    expect(createdOnOrAfter(null, '2026-11-26')).toBe(false)
    expect(createdOnOrAfter('yesterday', '2026-11-26')).toBe(false)
    expect(createdOnOrAfter('2026-11-26', 'soon')).toBe(false)
    // A day that does not exist never counts as the day it would roll over to.
    expect(createdOnOrAfter('2026-03-05', '2026-02-31')).toBe(false)
    expect(createdOnOrAfter('2026-02-31', '2026-02-01')).toBe(false)
  })
})

describe('pickFirstThing: the first thing', () => {
  it('importing a statement stands in for connecting the bank where no bank connection is offered', () => {
    const r = pickFirstThing(input({ hasBankFeed: false, hasTransactions: false, bankConnectOffered: false }))
    expect(r?.kind).toBe('import_bank_file')
    // With rows already in, the kind does not depend on whether a connection is offered.
    expect(pickFirstThing(input({ bankConnectOffered: false, counts: counts({ book_transaction: 3 }) }))?.kind).toBe('book_bank_rows')
  })

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

  it('a: imported books without any bank rows still open on connecting the bank', () => {
    const r = pickFirstThing(input({ hasBankFeed: false, hasTransactions: false, hasImportedBooks: true }))
    expect(r?.kind).toBe('connect_bank')
    expect(r?.lead).toBe('books')
  })

  it('a wins over missing receipts when the books are in and the bank is not', () => {
    const r = pickFirstThing(
      input({ hasBankFeed: false, hasTransactions: false, hasImportedBooks: true, counts: counts({ verifikat_missing_document: 4 }) }),
    )
    expect(r?.kind).toBe('connect_bank')
    expect(r?.after.map((task) => task.category)).toEqual(['verifikat_missing_document'])
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
          overdue_invoice: 1,
        }),
      }),
    )
    expect(r?.after).toHaveLength(3)
    expect(r?.after.map((t) => t.category)).toEqual(['book_skattekonto', 'inbox_document', 'supplier_invoice_approval'])
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
