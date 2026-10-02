import { describe, expect, it } from 'vitest'
import {
  INBOX_KIND_FILTERS,
  matchesInboxKindFilter,
  resolveInboxKind,
  type InboxDocumentKind,
} from '@/lib/documents/inbox-kind'

describe('resolveInboxKind', () => {
  it.each(['receipt', 'supplier_invoice', 'credit_note', 'government_letter', 'other'] as const)(
    'returns the AI documentKind %s when there is no sender hint',
    (kind) => {
      expect(resolveInboxKind({ extracted_data: { documentKind: kind } })).toBe(kind)
      expect(resolveInboxKind({ kind_hint: null, extracted_data: { documentKind: kind } })).toBe(kind)
    },
  )

  it('returns null when nothing is classified', () => {
    expect(resolveInboxKind({})).toBeNull()
    expect(resolveInboxKind({ extracted_data: null })).toBeNull()
    expect(resolveInboxKind({ extracted_data: {} })).toBeNull()
    expect(resolveInboxKind({ extracted_data: { documentKind: null } })).toBeNull()
  })

  it('returns null for a documentKind outside the vocabulary', () => {
    expect(resolveInboxKind({ extracted_data: { documentKind: 'parking_ticket' } })).toBeNull()
    expect(resolveInboxKind({ kind_hint: 'invoice' })).toBeNull()
  })

  it('lets the sender hint win over the AI classification', () => {
    expect(
      resolveInboxKind({ kind_hint: 'supplier_invoice', extracted_data: { documentKind: 'receipt' } }),
    ).toBe('supplier_invoice')
    expect(
      resolveInboxKind({ kind_hint: 'receipt', extracted_data: { documentKind: 'supplier_invoice' } }),
    ).toBe('receipt')
  })

  it('uses the sender hint even before extraction has landed', () => {
    expect(resolveInboxKind({ kind_hint: 'receipt', extracted_data: null })).toBe('receipt')
  })
})

describe('resolveInboxKind: credit notes (issue #2980)', () => {
  it('lets a credit-note reading refine a +lev supplier hint, never a +ver receipt hint', () => {
    expect(resolveInboxKind({ kind_hint: 'supplier_invoice', extracted_data: { documentKind: 'credit_note' } })).toBe('credit_note')
    expect(resolveInboxKind({ kind_hint: 'receipt', extracted_data: { documentKind: 'credit_note' } })).toBe('receipt')
  })

  it('reads a supplier invoice with a negative total, net or VAT as a credit note', () => {
    expect(
      resolveInboxKind({ extracted_data: { documentKind: 'supplier_invoice', totals: { total: -1250, subtotal: -1000, vatAmount: -250 } } }),
    ).toBe('credit_note')
    // The reported case: a positive total over a negative net and VAT.
    expect(
      resolveInboxKind({ extracted_data: { documentKind: 'supplier_invoice', totals: { total: 1250, subtotal: -1000, vatAmount: -250 } } }),
    ).toBe('credit_note')
    expect(
      resolveInboxKind({ kind_hint: 'supplier_invoice', extracted_data: { totals: { total: -1250 } } }),
    ).toBe('credit_note')
  })

  it('reads an unlabelled reading as a credit note only on a negative net or VAT', () => {
    expect(resolveInboxKind({ extracted_data: { totals: { subtotal: -1000, vatAmount: -250, total: -1250 } } })).toBe('credit_note')
    // A lone negative total is as often a bank statement's balance.
    expect(resolveInboxKind({ extracted_data: { totals: { total: -1250 } } })).toBeNull()
  })

  it('leaves receipts, letters and other documents with negative amounts alone', () => {
    expect(resolveInboxKind({ extracted_data: { documentKind: 'receipt', totals: { total: -99, subtotal: -79.2 } } })).toBe('receipt')
    expect(resolveInboxKind({ extracted_data: { documentKind: 'other', totals: { total: -5000 } } })).toBe('other')
  })

  it('keeps a positive supplier invoice a supplier invoice', () => {
    expect(
      resolveInboxKind({ extracted_data: { documentKind: 'supplier_invoice', totals: { total: 1250, subtotal: 1000, vatAmount: 250 } } }),
    ).toBe('supplier_invoice')
  })
})

describe('matchesInboxKindFilter', () => {
  const kinds: Array<InboxDocumentKind | null> = [
    'receipt',
    'supplier_invoice',
    'credit_note',
    'government_letter',
    'other',
    null,
  ]

  it("'all' passes every kind including unclassified", () => {
    for (const kind of kinds) expect(matchesInboxKindFilter(kind, 'all')).toBe(true)
  })

  it("'supplier_invoice' passes supplier invoices and credit notes", () => {
    expect(matchesInboxKindFilter('supplier_invoice', 'supplier_invoice')).toBe(true)
    expect(matchesInboxKindFilter('credit_note', 'supplier_invoice')).toBe(true)
    expect(matchesInboxKindFilter('receipt', 'supplier_invoice')).toBe(false)
    expect(matchesInboxKindFilter('government_letter', 'supplier_invoice')).toBe(false)
    expect(matchesInboxKindFilter('other', 'supplier_invoice')).toBe(false)
    expect(matchesInboxKindFilter(null, 'supplier_invoice')).toBe(false)
  })

  it("'underlag' passes receipt, government_letter and other", () => {
    expect(matchesInboxKindFilter('receipt', 'underlag')).toBe(true)
    expect(matchesInboxKindFilter('government_letter', 'underlag')).toBe(true)
    expect(matchesInboxKindFilter('other', 'underlag')).toBe(true)
    expect(matchesInboxKindFilter('supplier_invoice', 'underlag')).toBe(false)
    expect(matchesInboxKindFilter('credit_note', 'underlag')).toBe(false)
  })

  it('keeps unclassified items out of both narrow filters', () => {
    expect(matchesInboxKindFilter(null, 'underlag')).toBe(false)
    expect(matchesInboxKindFilter(null, 'supplier_invoice')).toBe(false)
  })

  it('exposes the three filters in menu order', () => {
    expect(INBOX_KIND_FILTERS).toEqual(['all', 'supplier_invoice', 'underlag'])
  })
})
