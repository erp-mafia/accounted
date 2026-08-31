import { describe, it, expect } from 'vitest'
import { orderByStalestSync } from '../sync-order'

describe('orderByStalestSync', () => {
  const work = [
    { companyId: 'a', userId: 'u' },
    { companyId: 'b', userId: 'u' },
    { companyId: 'c', userId: 'u' },
    { companyId: 'd', userId: 'u' },
  ]

  it('puts never-synced companies first, then the longest-ago synced, and keeps ties stable', () => {
    const last = new Map<string, string | null>([
      ['a', '2026-08-23T01:00:00Z'],
      ['b', '2026-08-22T01:00:00Z'],
      ['c', null],
      // d: no row at all
    ])
    expect(orderByStalestSync(work, last).map((w) => w.companyId)).toEqual(['c', 'd', 'b', 'a'])
  })

  it('keeps the incoming order when nothing is known', () => {
    expect(orderByStalestSync(work, new Map()).map((w) => w.companyId)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('treats an unparseable timestamp as never synced', () => {
    const last = new Map<string, string | null>([
      ['a', 'not-a-date'],
      ['b', '2026-08-22T01:00:00Z'],
    ])
    expect(orderByStalestSync(work, last).map((w) => w.companyId)).toEqual(['a', 'c', 'd', 'b'])
  })
})
