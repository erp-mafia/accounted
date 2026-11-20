import { describe, expect, it } from 'vitest'
import { unendedBatch } from '../unended-consents'

const DAY = 24 * 60 * 60 * 1000

describe('unendedBatch', () => {
  it('takes every held row when they fit in one run', () => {
    expect(unendedBatch(['a', 'b', 'c'], 0, 5)).toEqual(['a', 'b', 'c'])
  })

  it('takes at most one run of rows, from a window that moves every day, so every row gets its turn', () => {
    const held = ['a', 'b', 'c', 'd', 'e']
    expect(unendedBatch(held, 0, 2)).toEqual(['a', 'b'])
    expect(unendedBatch(held, DAY, 2)).toEqual(['c', 'd'])
    expect(unendedBatch(held, 2 * DAY, 2)).toEqual(['e', 'a'])
    // The same day answers the same window, whatever the hour.
    expect(unendedBatch(held, DAY + 5 * 60 * 60 * 1000, 2)).toEqual(['c', 'd'])
    const seen = new Set([0, 1, 2].flatMap((day) => unendedBatch(held, day * DAY, 2)))
    expect([...seen].sort()).toEqual(held)
  })
})
