import { describe, it, expect } from 'vitest'
import {
  reliabilityByBucket,
  expectedCalibrationError,
  fitIsotonic,
  calibrate,
  bandFor,
  type Sample,
} from '../calibration'

// Build N samples at a given confidence with a given true accuracy.
function samplesAt(confidence: number, accuracy: number, n: number): Sample[] {
  const correct = Math.round(accuracy * n)
  return Array.from({ length: n }, (_, i) => ({ confidence, correct: i < correct }))
}

describe('reliabilityByBucket', () => {
  it('reports empirical accuracy per confidence bucket', () => {
    const samples = [...samplesAt(0.95, 0.7, 100), ...samplesAt(0.55, 0.5, 100)]
    const buckets = reliabilityByBucket(samples, 10)
    const high = buckets.find((b) => b.lo === 0.9)!
    const mid = buckets.find((b) => b.lo === 0.5)!
    expect(high.n).toBe(100)
    expect(high.accuracy).toBeCloseTo(0.7, 2)
    expect(mid.accuracy).toBeCloseTo(0.5, 2)
  })
})

describe('expectedCalibrationError', () => {
  it('is ~0 for a well-calibrated corpus', () => {
    const samples = [...samplesAt(0.9, 0.9, 100), ...samplesAt(0.5, 0.5, 100)]
    expect(expectedCalibrationError(samples)).toBeLessThan(0.02)
  })
  it('is large for an overconfident corpus', () => {
    // Model says 0.95 but is only right 60% of the time.
    const samples = samplesAt(0.95, 0.6, 200)
    expect(expectedCalibrationError(samples)).toBeGreaterThan(0.3)
  })
})

describe('fitIsotonic', () => {
  it('returns null below the minimum sample count (stay uncalibrated)', () => {
    expect(fitIsotonic(samplesAt(0.9, 0.9, 50), 200)).toBeNull()
  })

  it('learns to pull an overconfident score down', () => {
    // 0.95 raw but only 60% correct → calibrated should be ~0.6, not ~0.95.
    const samples = [...samplesAt(0.95, 0.6, 300), ...samplesAt(0.5, 0.5, 300)]
    const cal = fitIsotonic(samples, 200)!
    expect(cal.fittedOn).toBe(600)
    expect(calibrate(0.95, cal)).toBeLessThan(0.7)
    expect(calibrate(0.95, cal)).toBeGreaterThan(0.5)
  })

  it('is monotonic non-decreasing (PAV guarantee)', () => {
    // Deliberately non-monotonic raw→accuracy; PAV must pool the violation.
    const samples = [
      ...samplesAt(0.4, 0.8, 200), // low conf but high accuracy
      ...samplesAt(0.7, 0.5, 200), // higher conf but lower accuracy (violation)
      ...samplesAt(0.9, 0.9, 200),
    ]
    const cal = fitIsotonic(samples, 200)!
    const grid = [0.3, 0.5, 0.7, 0.9]
    const vals = grid.map((r) => calibrate(r, cal))
    for (let i = 1; i < vals.length; i++) {
      expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1])
    }
  })

  it('lifts an underconfident score up', () => {
    // 0.55 raw but 90% correct → calibrated should be well above 0.55.
    const samples = [...samplesAt(0.55, 0.9, 300), ...samplesAt(0.2, 0.2, 300)]
    const cal = fitIsotonic(samples, 200)!
    expect(calibrate(0.55, cal)).toBeGreaterThan(0.8)
  })
})

describe('bandFor', () => {
  it('never auto-books without a calibrator, even at high raw confidence', () => {
    expect(bandFor(0.99, null, { amount: 100 })).toBe('suggest')
    expect(bandFor(0.6, null)).toBe('review')
  })

  it('auto-books a small amount at high calibrated probability with a calibrator', () => {
    const cal = fitIsotonic(samplesAt(0.96, 0.99, 400), 200)!
    expect(bandFor(0.96, cal, { amount: 499 })).toBe('auto')
  })

  it('never auto-books a large amount, however confident', () => {
    const cal = fitIsotonic(samplesAt(0.96, 0.99, 400), 200)!
    expect(bandFor(0.96, cal, { amount: 50000 })).toBe('suggest')
  })

  it('drops to review when the calibrated probability is low even if raw was high', () => {
    // raw 0.95 but the calibrator learned it is really ~0.6 → not auto, not even suggest at 0.7.
    const cal = fitIsotonic([...samplesAt(0.95, 0.6, 300), ...samplesAt(0.5, 0.5, 300)], 200)!
    expect(bandFor(0.95, cal, { amount: 100 })).toBe('review')
  })

  it('honours custom thresholds', () => {
    const cal = fitIsotonic(samplesAt(0.8, 0.85, 400), 200)!
    expect(bandFor(0.8, cal, { amount: 100, autoThreshold: 0.8 })).toBe('auto')
  })
})
