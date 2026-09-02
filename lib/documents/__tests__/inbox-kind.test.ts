import { describe, expect, it } from 'vitest'
import {
  INBOX_KIND_FILTERS,
  matchesInboxKindFilter,
  resolveInboxKind,
  type InboxDocumentKind,
} from '@/lib/documents/inbox-kind'

describe('resolveInboxKind', () => {
  it.each(['receipt', 'supplier_invoice', 'government_letter', 'other'] as const)(
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

describe('matchesInboxKindFilter', () => {
  const kinds: Array<InboxDocumentKind | null> = [
    'receipt',
    'supplier_invoice',
    'government_letter',
    'other',
    null,
  ]

  it("'all' passes every kind including unclassified", () => {
    for (const kind of kinds) expect(matchesInboxKindFilter(kind, 'all')).toBe(true)
  })

  it("'supplier_invoice' passes only supplier invoices", () => {
    expect(matchesInboxKindFilter('supplier_invoice', 'supplier_invoice')).toBe(true)
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
  })

  it('keeps unclassified items out of both narrow filters', () => {
    expect(matchesInboxKindFilter(null, 'underlag')).toBe(false)
    expect(matchesInboxKindFilter(null, 'supplier_invoice')).toBe(false)
  })

  it('exposes the three filters in menu order', () => {
    expect(INBOX_KIND_FILTERS).toEqual(['all', 'supplier_invoice', 'underlag'])
  })
})
