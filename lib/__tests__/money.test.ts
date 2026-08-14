import { describe, it, expect } from 'vitest'
import {
  roundOre,
  truncateToWholeKronor,
  ORE_TOLERANCE,
  equalOre,
  isZeroOre,
  sumOre,
} from '@/lib/money'

describe('roundOre', () => {
  it('rounds exact-half öre values up where naive Math.round fails', () => {
    // The whole reason this helper exists: 1.005 stored as 1.00499999… makes
    // naive Math.round(x*100)/100 yield 1.00. roundOre must give 1.01.
    expect(roundOre(1.005)).toBe(1.01)
    expect(roundOre(2.675)).toBe(2.68)
    expect(roundOre(0.615)).toBe(0.62)
  })

  it('leaves well-formed decimals untouched', () => {
    expect(roundOre(1.234)).toBe(1.23)
    expect(roundOre(1.235)).toBe(1.24)
    expect(roundOre(100)).toBe(100)
    expect(roundOre(1234.56)).toBe(1234.56)
  })

  it('preserves the sign of negative zero', () => {
    expect(Object.is(roundOre(-0), -0)).toBe(true)
    expect(roundOre(0)).toBe(0)
  })

  it('handles negative amounts', () => {
    expect(roundOre(-1.234)).toBe(-1.23)
    expect(roundOre(-99.999)).toBe(-100)
    // The EPSILON nudge moves a stored negative value slightly toward zero, so
    // an exact-half negative rounds toward +∞ (mirrors Math.round on negatives):
    // -1.005 → -1.00, not -1.01. Documented so a refactor can't silently flip it.
    expect(roundOre(-1.005)).toBe(-1)
  })
})

describe('truncateToWholeKronor', () => {
  it('drops the öre entirely: truncation, never rounding', () => {
    // öretal bortfaller (SFF 2011:1261 22 kap. 1 §): 16 073,84 declares and
    // draws as 16 073, and even ,99 never rounds up.
    expect(truncateToWholeKronor(16073.84)).toBe(16073)
    expect(truncateToWholeKronor(16073.99)).toBe(16073)
    expect(truncateToWholeKronor(16073.5)).toBe(16073)
    expect(truncateToWholeKronor(0.84)).toBe(0)
  })

  it('leaves whole-krona amounts untouched', () => {
    expect(truncateToWholeKronor(16073)).toBe(16073)
    expect(truncateToWholeKronor(0)).toBe(0)
  })

  it('does not lose a krona to IEEE drift just below an integer', () => {
    // 51 158 × 0,3142 style float noise: a true 16 074,00 stored as
    // 16 073,999999999998 must not truncate to 16 073.
    expect(truncateToWholeKronor(16073.999999999998)).toBe(16074)
    expect(truncateToWholeKronor(6.999999999999999)).toBe(7)
  })

  it('truncates negative amounts toward zero and normalizes -0', () => {
    expect(truncateToWholeKronor(-5.99)).toBe(-5)
    expect(truncateToWholeKronor(-0.84)).toBe(0)
    expect(Object.is(truncateToWholeKronor(-0.84), -0)).toBe(false)
  })
})

describe('ORE_TOLERANCE / equalOre / isZeroOre', () => {
  it('is half an öre', () => {
    expect(ORE_TOLERANCE).toBe(0.005)
  })

  it('treats sub-öre float drift as equal', () => {
    expect(equalOre(0.1 + 0.2, 0.3)).toBe(true) // classic 0.30000000000000004
    expect(equalOre(100.001, 100.0)).toBe(true)
  })

  it('flags a real one-öre discrepancy as not equal', () => {
    expect(equalOre(100.01, 100.0)).toBe(false)
  })

  it('isZeroOre absorbs drift around zero', () => {
    expect(isZeroOre(0.1 + 0.2 - 0.3)).toBe(true)
    expect(isZeroOre(0.01)).toBe(false)
  })
})

describe('sumOre', () => {
  it('sums then rounds once', () => {
    expect(sumOre([0.1, 0.2])).toBe(0.3)
    expect(sumOre([1.005, 1.005])).toBe(2.01)
    expect(sumOre([])).toBe(0)
  })
})

describe('lib/bokslut/rounding back-compat re-export', () => {
  it('exposes the same roundOre/ORE_TOLERANCE from the legacy path', async () => {
    const legacy = await import('@/lib/bokslut/rounding')
    expect(legacy.roundOre(1.005)).toBe(1.01)
    expect(legacy.ORE_TOLERANCE).toBe(ORE_TOLERANCE)
  })
})
