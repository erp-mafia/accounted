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

  it('rounds exact halves up at every magnitude, not only near 1', () => {
    // The Number.EPSILON nudge this helper used to carry is a fixed absolute
    // quantity, while the gap between neighbouring doubles doubles with every
    // power of two. From roughly 2.13 upward the nudge was too small and these
    // all rounded down: 10.075 came back as 10.07, 8.575 as 8.57.
    expect(roundOre(2.135)).toBe(2.14)
    expect(roundOre(8.575)).toBe(8.58)
    expect(roundOre(10.075)).toBe(10.08)
    expect(roundOre(1005.005)).toBe(1005.01)
    expect(roundOre(12345.675)).toBe(12345.68)
  })

  it('leaves well-formed decimals untouched', () => {
    expect(roundOre(1.234)).toBe(1.23)
    expect(roundOre(1.235)).toBe(1.24)
    expect(roundOre(100)).toBe(100)
    expect(roundOre(1234.56)).toBe(1234.56)
  })

  it('leaves well-formed decimals untouched at large magnitude too', () => {
    expect(roundOre(98765.43)).toBe(98765.43)
    expect(roundOre(1234567.89)).toBe(1234567.89)
    expect(roundOre(99999999.99)).toBe(99999999.99)
    expect(roundOre(12345.671)).toBe(12345.67)
    expect(roundOre(12345.679)).toBe(12345.68)
  })

  it('collapses accumulated float drift', () => {
    expect(roundOre(0.1 + 0.2)).toBe(0.3)
    expect(roundOre(16073.999999999998)).toBe(16074)
  })

  it('preserves the sign of negative zero', () => {
    expect(Object.is(roundOre(-0), -0)).toBe(true)
    expect(roundOre(0)).toBe(0)
  })

  it('collapses a sub-öre negative to a plain zero, never -0', () => {
    // Intl renders -0 as "-0,00 kr". A residual smaller than half an öre is
    // nothing, so it must not carry a sign into a report.
    expect(Object.is(roundOre(-0.001), -0)).toBe(false)
    expect(roundOre(-0.001)).toBe(0)
    expect(roundOre(-0.004)).toBe(0)
    expect(roundOre(-0.006)).toBe(-0.01)
  })

  it('passes non-finite values through untouched', () => {
    // The decimal shift goes through String(n); 'NaNe2' and 'Infinitye2' are
    // not parseable numbers, so non-finite inputs must never reach it.
    expect(Number.isNaN(roundOre(NaN))).toBe(true)
    expect(roundOre(Infinity)).toBe(Infinity)
    expect(roundOre(-Infinity)).toBe(-Infinity)
  })

  it('handles negative amounts', () => {
    expect(roundOre(-1.234)).toBe(-1.23)
    expect(roundOre(-99.999)).toBe(-100)
    // Negative exact halves round toward positive infinity: Math.round's own
    // asymmetry, kept deliberately. -1.005 → -1.00, not -1.01. Symmetric
    // away-from-zero rounding would move credit notes and reversals one öre
    // relative to the invoices they cancel, so it is a founder decision, not a
    // refactor. Pinned here so it cannot flip silently.
    expect(roundOre(-1.005)).toBe(-1)
    expect(roundOre(-10.075)).toBe(-10.07)
    expect(roundOre(-12345.675)).toBe(-12345.67)
  })

  it('rounds every positive exact half up across a full sweep of magnitudes', () => {
    // Values are built from string literals so the test never asks the same
    // float arithmetic the helper is fixing to say what the input "really" is.
    // Expected values come from integer arithmetic on thousandths.
    const failures: string[] = []
    for (let thousandths = 5; thousandths < 200_000; thousandths += 10) {
      const literal = `${Math.floor(thousandths / 1000)}.${String(thousandths % 1000).padStart(3, '0')}`
      const expected = Number(`${(thousandths + 5) / 10}e-2`)
      const actual = roundOre(Number(literal))
      if (!Object.is(actual, expected)) failures.push(`${literal} → ${actual}, expected ${expected}`)
    }
    expect(failures).toEqual([])
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

  it('rounds a large total half up like roundOre does', () => {
    expect(sumOre([10000, 0.075])).toBe(10000.08)
    expect(sumOre([8.575])).toBe(8.58)
  })
})

describe('lib/bokslut/rounding back-compat re-export', () => {
  it('exposes the same roundOre/ORE_TOLERANCE from the legacy path', async () => {
    const legacy = await import('@/lib/bokslut/rounding')
    expect(legacy.roundOre(1.005)).toBe(1.01)
    expect(legacy.roundOre(10.075)).toBe(10.08)
    expect(legacy.ORE_TOLERANCE).toBe(ORE_TOLERANCE)
  })
})
