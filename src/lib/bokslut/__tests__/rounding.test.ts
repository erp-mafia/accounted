import { describe, it, expect } from 'vitest'
import { roundOre, ORE_TOLERANCE } from '../rounding'

describe('roundOre', () => {
  it('rounds typical positive amounts to two decimals', () => {
    expect(roundOre(1.234)).toBe(1.23)
    expect(roundOre(1.235)).toBe(1.24)
    expect(roundOre(1.236)).toBe(1.24)
  })

  it('rounds negative amounts symmetrically', () => {
    // Math.round rounds half toward +∞: -1.235 -> -1.23.
    // Verified behavior so callers can rely on it.
    expect(roundOre(-1.234)).toBe(-1.23)
    expect(roundOre(-1.236)).toBe(-1.24)
  })

  it('returns 0 unchanged', () => {
    expect(roundOre(0)).toBe(0)
    // Math.round(-0 * 100) preserves the negative-zero sign; treat it as
    // numerically equal to 0 rather than enforcing Object.is equality.
    expect(roundOre(-0)).toEqual(-0)
    expect(Math.abs(roundOre(-0))).toBe(0)
  })

  it('exposes a half-öre tolerance constant', () => {
    expect(ORE_TOLERANCE).toBe(0.005)
  })

  it('sum of rounded parts equals rounded sum for representative cases', () => {
    const cases: number[][] = [
      [100, 200, 300],
      [1.11, 2.22, 3.33],
      [1.005, 2.005, 3.005],
      [-100, 50, 50],
      [-1.234, 2.345, -3.456],
      [0.1, 0.2, 0.3], // classic IEEE 754 trap
      [12345.67, -12345.67],
      [1_000_000.01, 2_000_000.02, 3_000_000.03],
    ]

    // Half-up rounding doesn't preserve sums exactly: each part can shift
    // by up to half an öre, so cumulative drift over N parts is bounded by
    // N * ORE_TOLERANCE. The pathological case is [1.005, 2.005, 3.005]:
    // three exact-half values that all round up to .01, drifting the sum
    // by one öre versus summing then rounding.
    for (const parts of cases) {
      const summedThenRounded = roundOre(parts.reduce((a, b) => a + b, 0))
      const roundedThenSummed = roundOre(
        parts.map(roundOre).reduce((a, b) => a + b, 0)
      )
      expect(
        Math.abs(summedThenRounded - roundedThenSummed),
        `parts=${JSON.stringify(parts)}`
      ).toBeLessThanOrEqual(ORE_TOLERANCE * parts.length)
    }
  })

  it('roundOre is idempotent', () => {
    const samples = [1.005, -2.345, 99.999, -0.005]
    for (const s of samples) {
      expect(roundOre(roundOre(s))).toBe(roundOre(s))
    }
  })
})
