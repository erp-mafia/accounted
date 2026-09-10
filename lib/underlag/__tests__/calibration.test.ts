import { describe, it, expect } from 'vitest'
import { MIN_BIN_SAMPLES, calibratedProbability, makeMonotone, type CalibrationBin } from '../calibration'

const bins: CalibrationBin[] = [
  { lo: 0.6, hi: 0.7, n: 40, precision: 0.55 },
  { lo: 0.7, hi: 0.8, n: 60, precision: 0.8 },
  { lo: 0.8, hi: 0.9, n: 30, precision: 0.7 }, // a violator: lower than its predecessor
  { lo: 0.9, hi: 1.0, n: 200, precision: 0.97 },
]

describe('makeMonotone', () => {
  it('pools a bin whose precision drops below the one before it', () => {
    const out = makeMonotone(bins)
    expect(out).toHaveLength(3)
    const pooled = out[1]
    expect(pooled.lo).toBe(0.7)
    expect(pooled.hi).toBe(0.9)
    expect(pooled.n).toBe(90)
    expect(pooled.precision).toBeCloseTo((0.8 * 60 + 0.7 * 30) / 90, 6)
  })

  it('pools bins too thin to trust', () => {
    const thin: CalibrationBin[] = [
      { lo: 0.6, hi: 0.8, n: 50, precision: 0.6 },
      { lo: 0.8, hi: 0.9, n: MIN_BIN_SAMPLES - 1, precision: 1 },
      { lo: 0.9, hi: 1.0, n: 50, precision: 0.95 },
    ]
    const out = makeMonotone(thin)
    expect(out.every((b) => b.n >= MIN_BIN_SAMPLES)).toBe(true)
  })
})

describe('calibratedProbability', () => {
  it('returns the measured precision of the interval the score falls in', () => {
    expect(calibratedProbability(0.95, bins)).toBe(0.97)
    expect(calibratedProbability(0.65, bins)).toBe(0.55)
    expect(calibratedProbability(1, bins)).toBe(0.97)
  })

  it('answers null when nothing has been measured', () => {
    expect(calibratedProbability(0.9, [])).toBeNull()
    expect(calibratedProbability(0.3, bins)).toBeNull()
  })
})
