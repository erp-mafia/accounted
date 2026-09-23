import { describe, it, expect } from 'vitest'
import { groupRows, ungrouped } from '../group-rows'

interface Row {
  id: string
  customerId: string | null
  customerName: string
  month: string
}

const rows: Row[] = [
  { id: 'a', customerId: 'c1', customerName: 'Ådalen AB', month: '2026-08' },
  { id: 'b', customerId: 'c2', customerName: 'Bolag AB', month: '2026-09' },
  { id: 'c', customerId: 'c1', customerName: 'Ådalen AB', month: '2026-09' },
  { id: 'd', customerId: 'c3', customerName: 'Ådalen AB', month: '2026-08' },
]

const byCustomer = {
  keyOf: (row: Row) => ({ key: row.customerId ?? row.customerName, label: row.customerName }),
  order: (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, 'sv'),
}

describe('ungrouped', () => {
  it('keeps the order and marks every row keyless', () => {
    const result = ungrouped(rows)
    expect(result.rows.map((r) => r.row.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(result.rows.every((r) => r.groupKey === null)).toBe(true)
    expect(result.meta.size).toBe(0)
  })
})

describe('groupRows', () => {
  it('buckets by key and preserves the incoming order inside each bucket', () => {
    const { rows: flat, meta } = groupRows(rows, byCustomer)

    // Sections ordered by label (sv collation puts Å last), rows keep a-c / b / d order.
    expect(flat.map((r) => r.row.id)).toEqual(['b', 'a', 'c', 'd'])
    expect([...meta.keys()]).toEqual(['c2', 'c1', 'c3'])
    expect(meta.get('c1')).toEqual({ label: 'Ådalen AB', count: 2 })
  })

  it('separates two customers sharing a display name', () => {
    const { meta } = groupRows(rows, byCustomer)
    expect(meta.get('c1')?.label).toBe('Ådalen AB')
    expect(meta.get('c3')?.label).toBe('Ådalen AB')
    expect(meta.get('c1')?.count).toBe(2)
    expect(meta.get('c3')?.count).toBe(1)
  })

  it('follows a fixed order and drops keys it does not list', () => {
    const { rows: flat, meta } = groupRows(rows, {
      keyOf: (row) => ({ key: row.month, label: row.month }),
      order: ['2026-09', '2026-07'],
    })
    expect([...meta.keys()]).toEqual(['2026-09'])
    expect(flat.map((r) => r.row.id)).toEqual(['b', 'c'])
  })

  it('every flattened row carries the key of its section', () => {
    const { rows: flat } = groupRows(rows, byCustomer)
    for (const entry of flat) {
      expect(entry.groupKey).toBe(entry.row.customerId)
    }
  })

  it('handles an empty list', () => {
    const { rows: flat, meta } = groupRows([], byCustomer)
    expect(flat).toEqual([])
    expect(meta.size).toBe(0)
  })
})
