import { describe, it, expect } from 'vitest'
import { planArticleUpserts, type PlannedArticleUpdate } from '../bulk-update'

const planned = (id: string, merged: Record<string, unknown>, rowIndex = 2): PlannedArticleUpdate => ({
  id,
  merged,
  rows: [{ row_index: rowIndex, name: String(merged.name ?? id) }],
})

const stored = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  company_id: 'company-1',
  user_id: 'owner-1',
  name: `Stored ${id}`,
  price_excl_vat: 1,
  ...extra,
})

describe('planArticleUpserts (crm#1383)', () => {
  it('puts updates that change the same fields in one statement, with the stored identity columns', () => {
    const snapshot = new Map([
      ['a', stored('a')],
      ['b', stored('b')],
    ])
    const { slices, rowByRow } = planArticleUpserts(
      [planned('a', { name: 'Skruv', price_excl_vat: 10 }), planned('b', { name: 'Mutter', price_excl_vat: 20 })],
      snapshot,
      'company-1',
      500,
    )
    expect(rowByRow).toEqual([])
    expect(slices).toHaveLength(1)
    expect(slices[0].map((s) => s.payload)).toEqual([
      { id: 'a', company_id: 'company-1', user_id: 'owner-1', name: 'Skruv', price_excl_vat: 10 },
      { id: 'b', company_id: 'company-1', user_id: 'owner-1', name: 'Mutter', price_excl_vat: 20 },
    ])
  })

  it('never sets a field a row does not carry: different fields go in different statements', () => {
    const snapshot = new Map([
      ['a', stored('a')],
      ['b', stored('b')],
    ])
    const { slices } = planArticleUpserts(
      [planned('a', { name: 'Skruv', price_excl_vat: 10 }), planned('b', { name: 'Mutter', ean: '7310000000000' })],
      snapshot,
      'company-1',
      500,
    )
    expect(slices).toHaveLength(2)
    for (const slice of slices) {
      const fields = new Set(slice.map((s) => Object.keys(s.payload).sort().join(',')))
      expect(fields.size).toBe(1)
    }
    expect(slices[1][0].payload).not.toHaveProperty('price_excl_vat')
  })

  it('keeps the stored name when the file does not change it', () => {
    const { slices } = planArticleUpserts(
      [planned('a', { price_excl_vat: 10 })],
      new Map([['a', stored('a')]]),
      'company-1',
      500,
    )
    expect(slices[0][0].payload).toMatchObject({ name: 'Stored a', price_excl_vat: 10 })
  })

  it('slices a group at the slice size, in order', () => {
    const updates = Array.from({ length: 1200 }, (_, i) => planned(`id-${i}`, { name: `A ${i}`, price_excl_vat: i + 1 }))
    const snapshot = new Map(updates.map((u) => [u.id, stored(u.id)]))
    const { slices } = planArticleUpserts(updates, snapshot, 'company-1', 500)
    expect(slices.map((s) => s.length)).toEqual([500, 500, 200])
    expect(slices.flat().map((s) => s.planned.id)).toEqual(updates.map((u) => u.id))
  })

  it('leaves an article the snapshot does not hold, or holds for another company, to a plain update', () => {
    const snapshot = new Map([['b', stored('b', { company_id: 'company-2' })]])
    const a = planned('a', { name: 'Borttagen', price_excl_vat: 10 })
    const b = planned('b', { name: 'Annan', price_excl_vat: 10 })
    const { slices, rowByRow } = planArticleUpserts([a, b], snapshot, 'company-1', 500)
    expect(slices).toEqual([])
    expect(rowByRow).toEqual([a, b])
  })
})
