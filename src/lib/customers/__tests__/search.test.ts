import { describe, it, expect } from 'vitest'
import {
  buildCustomerIndex,
  searchCustomers,
  customerPickerSecondary,
  CUSTOMER_SEARCH_LIMIT,
  type SearchableCustomer,
} from '../search'

// A register the way /api/customers serves it: personnummer already masked,
// archived rows filtered server-side except the one a draft keeps.
const customers: SearchableCustomer[] = [
  { id: 'c1', name: 'Anna Andersson', customer_type: 'individual', customer_number: '12', personal_number: '********-1234', email: 'anna.andersson@example.se' },
  { id: 'c2', name: 'Sandersson Bygg AB', customer_type: 'swedish_business', customer_number: '120', org_number: '556000-0000', email: 'faktura@sandersson.se' },
  { id: 'c3', name: 'Björn Löfgren', customer_type: 'individual', customer_number: '7', personal_number: '********-5678', email: 'bjorn@example.se' },
  { id: 'c4', name: 'Örjan Söderberg', customer_type: 'individual', customer_number: null, email: 'orjan@example.se' },
  { id: 'c5', name: 'Zeta Konsult AB', customer_type: 'swedish_business', customer_number: '2', org_number: '559999-1111', email: null },
  { id: 'c6', name: 'Anders Berg', customer_type: 'individual', customer_number: '13', email: 'anders@berg.se' },
]

const idx = buildCustomerIndex(customers)
const ids = (items: { id: string }[]) => items.map((i) => i.id)

describe('buildCustomerIndex', () => {
  it('orders the index alphabetically with Swedish collation', () => {
    expect(ids(idx.map((e) => e.item))).toEqual(['c6', 'c1', 'c3', 'c2', 'c5', 'c4'])
  })

  it('drops archived customers unless their id is kept', () => {
    const withArchived: SearchableCustomer[] = [
      ...customers,
      { id: 'old', name: 'Gamla Kunden AB', archived_at: '2026-01-01T00:00:00Z' },
      { id: 'draft', name: 'Kund På Utkastet', archived_at: '2026-01-01T00:00:00Z' },
    ]
    const dropped = buildCustomerIndex(withArchived)
    expect(ids(dropped.map((e) => e.item))).not.toContain('old')
    expect(ids(dropped.map((e) => e.item))).not.toContain('draft')

    const kept = buildCustomerIndex(withArchived, { keepIds: ['draft', null, undefined] })
    expect(ids(kept.map((e) => e.item))).toContain('draft')
    expect(ids(kept.map((e) => e.item))).not.toContain('old')
  })

  it('dedupes on id so a kept row appended to the cache is not listed twice', () => {
    const doubled = buildCustomerIndex([...customers, customers[0]])
    expect(doubled.filter((e) => e.item.id === 'c1')).toHaveLength(1)
  })

  it('does not index a ciphertext personnummer', () => {
    const raw = buildCustomerIndex([
      { id: 'r1', name: 'Rå Rad', customer_type: 'individual', personal_number: 'v1:9f3a7c2e:ZmFrZQ==' },
    ])
    expect(raw[0].haystack).not.toContain('9f3a7c2e')
    expect(raw[0].identDigits).toEqual([])
    expect(searchCustomers(raw, '9f3a').items).toEqual([])
  })
})

describe('searchCustomers', () => {
  it('returns the whole list alphabetically for an empty query', () => {
    const r = searchCustomers(idx, '   ')
    expect(ids(r.items)).toEqual(['c6', 'c1', 'c3', 'c2', 'c5', 'c4'])
    expect(r.total).toBe(6)
  })

  it('matches anywhere in the name, so a surname finds the customer', () => {
    const r = searchCustomers(idx, 'andersson')
    expect(ids(r.items)).toEqual(['c1', 'c2'])
  })

  it('ranks a word-start hit (surname) above a mid-word hit', () => {
    // "Sandersson" contains "andersson" mid-word; Anna's surname starts with it.
    expect(ids(searchCustomers(idx, 'andersson').items)[0]).toBe('c1')
  })

  it('is case-insensitive', () => {
    expect(ids(searchCustomers(idx, 'ANNA').items)).toEqual(['c1'])
    expect(ids(searchCustomers(idx, 'zeta konsult').items)).toEqual(['c5'])
  })

  it('is diacritics-insensitive in both directions', () => {
    expect(ids(searchCustomers(idx, 'lofgren').items)).toEqual(['c3'])
    expect(ids(searchCustomers(idx, 'Löfgren').items)).toEqual(['c3'])
    expect(ids(searchCustomers(idx, 'soderberg').items)).toEqual(['c4'])
    expect(ids(searchCustomers(idx, 'orjan').items)).toEqual(['c4'])
  })

  it('requires every token, in any order', () => {
    expect(ids(searchCustomers(idx, 'anna andersson').items)).toEqual(['c1'])
    expect(ids(searchCustomers(idx, 'andersson anna').items)).toEqual(['c1'])
    expect(ids(searchCustomers(idx, 'anna bygg').items)).toEqual([])
  })

  it('matches the customer number and ranks the exact number first', () => {
    const r = searchCustomers(idx, '12')
    expect(ids(r.items)[0]).toBe('c1')
    expect(ids(r.items)).toContain('c2')
    expect(ids(searchCustomers(idx, '7').items)).toEqual(['c3'])
  })

  it('matches the org number with or without the hyphen', () => {
    expect(ids(searchCustomers(idx, '556000-0000').items)).toEqual(['c2'])
    expect(ids(searchCustomers(idx, '5560000000').items)).toEqual(['c2'])
    expect(ids(searchCustomers(idx, '9999-11').items)).toEqual(['c5'])
  })

  it('matches the visible suffix of a masked personnummer', () => {
    expect(ids(searchCustomers(idx, '5678').items)).toEqual(['c3'])
    expect(ids(searchCustomers(idx, '********-1234').items)).toEqual(['c1'])
  })

  it('matches a plaintext personnummer typed with or without separator', () => {
    const plain = buildCustomerIndex([
      { id: 'p1', name: 'Plain Person', customer_type: 'individual', personal_number: '19900101-1234' },
    ])
    expect(ids(searchCustomers(plain, '900101').items)).toEqual(['p1'])
    expect(ids(searchCustomers(plain, '199001011234').items)).toEqual(['p1'])
  })

  it('matches part of an email', () => {
    expect(ids(searchCustomers(idx, 'anna.andersson@').items)).toEqual(['c1'])
    expect(ids(searchCustomers(idx, 'example.se').items)).toEqual(['c1', 'c3', 'c4'])
    expect(ids(searchCustomers(idx, 'faktura@').items)).toEqual(['c2'])
  })

  it('ranks a word-start name hit above a mid-word one', () => {
    // "berg" starts Anders Berg's surname and sits mid-word in Söderberg.
    const r = searchCustomers(idx, 'berg')
    expect(ids(r.items)[0]).toBe('c6')
    expect(ids(r.items)).toContain('c4')
  })

  it('caps the result and reports the pre-cap total', () => {
    const many: SearchableCustomer[] = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`,
      name: `Kund ${String(i).padStart(3, '0')}`,
      email: `kund${i}@example.se`,
    }))
    const bigIdx = buildCustomerIndex(many)

    const all = searchCustomers(bigIdx, '')
    expect(all.items).toHaveLength(CUSTOMER_SEARCH_LIMIT)
    expect(all.total).toBe(60)

    const hits = searchCustomers(bigIdx, 'kund')
    expect(hits.items).toHaveLength(CUSTOMER_SEARCH_LIMIT)
    expect(hits.total).toBe(60)

    // "05" is in Kund 005 and Kund 050 through Kund 059.
    const narrowed = searchCustomers(bigIdx, 'kund 05')
    expect(narrowed.total).toBe(11)
    expect(narrowed.items).toHaveLength(11)

    expect(searchCustomers(bigIdx, '', 10).items).toHaveLength(10)
  })

  it('returns nothing for a query that matches nothing', () => {
    const r = searchCustomers(idx, 'xyzzy')
    expect(r.items).toEqual([])
    expect(r.total).toBe(0)
  })
})

describe('customerPickerSecondary', () => {
  it('joins customer number, identifier and email', () => {
    expect(customerPickerSecondary(customers[1])).toBe('120 · 556000-0000 · faktura@sandersson.se')
  })

  it('keeps a masked personnummer masked and masks a plaintext one', () => {
    expect(customerPickerSecondary(customers[0])).toBe('12 · ********-1234 · anna.andersson@example.se')
    expect(
      customerPickerSecondary({ id: 'p', name: 'P', customer_type: 'individual', personal_number: '19900101-1234' }),
    ).toBe('********-1234')
    expect(
      customerPickerSecondary({ id: 'b', name: 'B', customer_type: 'swedish_business', personal_number: '19900101-1234' }),
    ).toBe('********-1234')
  })

  it('never renders ciphertext and copes with the minimal id + name shape', () => {
    expect(
      customerPickerSecondary({ id: 'r', name: 'R', customer_type: 'individual', personal_number: 'v1:9f3a7c2e:ZmFrZQ==' }),
    ).toBe('')
    expect(customerPickerSecondary({ id: 'd', name: 'Deadline Kund' })).toBe('')
  })
})
