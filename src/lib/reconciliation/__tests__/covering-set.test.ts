import { describe, it, expect } from 'vitest'
import { findExactCoveringSet } from '../covering-set'

function c(id: string, amount: number, dateDistanceDays = 0) {
  return { id, amount, dateDistanceDays }
}

describe('findExactCoveringSet', () => {
  it('returns null for an empty list or a non-positive target', () => {
    expect(findExactCoveringSet(100, [])).toBeNull()
    expect(findExactCoveringSet(0, [c('a', 100)])).toBeNull()
    expect(findExactCoveringSet(-100, [c('a', 100)])).toBeNull()
  })

  it('finds the single voucher of the same amount', () => {
    const set = findExactCoveringSet(1000, [c('a', 999), c('b', 1000), c('c', 1)])
    expect(set?.map((s) => s.id)).toEqual(['b'])
  })

  it('finds the Bankgirot aggregate: two vouchers that sum to the row', () => {
    // gecko's case: 62 500 + 25 750 booked by hand, one 88 250 bank row.
    const set = findExactCoveringSet(88250, [c('A57', 62500), c('A58', 25750), c('A56', 150)])
    expect(set?.map((s) => s.id).sort()).toEqual(['A57', 'A58'])
  })

  it('prefers the smallest set, then the one closest in date', () => {
    const one = findExactCoveringSet(1000, [c('pair-1', 400, 0), c('pair-2', 600, 0), c('single', 1000, 3)])
    expect(one?.map((s) => s.id)).toEqual(['single'])

    const near = findExactCoveringSet(1000, [c('far', 1000, 6), c('near', 1000, 1)])
    expect(near?.map((s) => s.id)).toEqual(['near'])
  })

  it('is exact to the öre and never reads a near miss as a match', () => {
    expect(findExactCoveringSet(1000, [c('a', 999.99)])).toBeNull()
    expect(findExactCoveringSet(1000.01, [c('a', 600), c('b', 400.01)])?.map((s) => s.id)).toEqual(['a', 'b'])
    expect(findExactCoveringSet(1000, [c('a', 600), c('b', 400.01)])).toBeNull()
  })

  it('ignores candidates larger than the target or with no amount', () => {
    const set = findExactCoveringSet(500, [c('big', 5000), c('zero', 0), c('neg', -500), c('ok', 500)])
    expect(set?.map((s) => s.id)).toEqual(['ok'])
  })

  it('stops at maxSize and caps the candidate pool', () => {
    const parts = [c('a', 100), c('b', 200), c('c', 300), c('d', 400)]
    expect(findExactCoveringSet(1000, parts, { maxSize: 3 })).toBeNull()
    expect(findExactCoveringSet(1000, parts, { maxSize: 4 })?.length).toBe(4)
    // Pool cap keeps only the two closest rows, so the pair cannot be formed.
    const far = [c('near-1', 100, 0), c('near-2', 200, 0), c('far-1', 700, 5)]
    expect(findExactCoveringSet(1000, far, { maxCandidates: 2 })).toBeNull()
  })

  it('handles a busy account without blowing up', () => {
    const many = Array.from({ length: 200 }, (_, i) => c(`v${i}`, 100 + (i % 37) * 13, i % 8))
    const start = Date.now()
    const set = findExactCoveringSet(100 + 113 + 126 + 139, many)
    expect(Date.now() - start).toBeLessThan(500)
    expect(set).not.toBeNull()
  })
})
