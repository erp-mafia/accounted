/**
 * Calibration for the auto-booking cascade (step 4).
 *
 * The Tier-2 selector emits a raw combined confidence in [0,1], but raw model/
 * ensemble scores are NOT calibrated: "0.9" does not mean "right 90% of the
 * time" until you fit it against real outcomes. This module turns a corpus of
 * (confidence, was_correct) samples — collected as users book or edit the
 * proposals — into a monotonic calibrator (isotonic regression), and decides
 * the auto-book / suggest / review band from the CALIBRATED probability.
 *
 * Until a calibrator is fitted (not enough data yet), `bandFor` runs in
 * uncalibrated mode: it never returns 'auto' (no silent booking on an
 * unproven score) and uses conservative raw thresholds for suggest/review.
 * This is what keeps "säker" honest before the data exists.
 *
 * Pure functions only: no I/O. The samples come from the caller.
 */

export interface Sample {
  /** Raw combined confidence the selector reported, in [0,1]. */
  confidence: number
  /** True when the proposed account was the one actually booked (unedited). */
  correct: boolean
}

/** A fitted, monotonic non-decreasing mapping from raw confidence to calibrated probability. */
export interface Calibrator {
  /** Sorted ascending; each point maps a raw confidence to its calibrated probability. */
  points: { raw: number; calibrated: number }[]
  /** How many samples it was fitted on (for trust / staleness checks). */
  fittedOn: number
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/**
 * Reliability diagram: bucket samples by confidence and report empirical
 * accuracy per bucket. The gap between meanConfidence and accuracy is the
 * miscalibration; the classic "overconfident" model shows accuracy < confidence.
 */
export function reliabilityByBucket(
  samples: Sample[],
  bins = 10,
): { lo: number; hi: number; n: number; meanConfidence: number; accuracy: number }[] {
  const out: { lo: number; hi: number; n: number; meanConfidence: number; accuracy: number }[] = []
  for (let b = 0; b < bins; b++) {
    const lo = b / bins
    const hi = (b + 1) / bins
    const inBucket = samples.filter(
      (s) => s.confidence >= lo && (b === bins - 1 ? s.confidence <= hi : s.confidence < hi),
    )
    const n = inBucket.length
    const meanConfidence = n ? inBucket.reduce((a, s) => a + s.confidence, 0) / n : 0
    const accuracy = n ? inBucket.filter((s) => s.correct).length / n : 0
    out.push({ lo, hi, n, meanConfidence, accuracy })
  }
  return out
}

/**
 * Expected Calibration Error: the sample-weighted average |confidence - accuracy|
 * across buckets. 0 = perfectly calibrated. Empty buckets contribute nothing.
 */
export function expectedCalibrationError(samples: Sample[], bins = 10): number {
  if (samples.length === 0) return 0
  const buckets = reliabilityByBucket(samples, bins)
  let err = 0
  for (const bkt of buckets) {
    if (bkt.n === 0) continue
    err += (bkt.n / samples.length) * Math.abs(bkt.meanConfidence - bkt.accuracy)
  }
  return err
}

/**
 * Fit an isotonic (monotonic non-decreasing) calibrator via pool-adjacent-
 * violators (PAV). This is the standard, distribution-free way to calibrate a
 * ranking score: it never assumes a parametric shape, only that higher raw
 * confidence should not map to lower true accuracy.
 *
 * Returns null when there is too little data to trust (below `minSamples`):
 * the caller then stays in uncalibrated mode.
 */
export function fitIsotonic(samples: Sample[], minSamples = 200): Calibrator | null {
  if (samples.length < minSamples) return null

  // Sort by raw confidence; y = 1 for correct, 0 for wrong.
  const sorted = [...samples].sort((a, b) => a.confidence - b.confidence)

  // PAV over blocks of (sum, count) → each block's mean is monotonic non-decreasing.
  interface Block {
    x: number // representative raw confidence (max in block, so it's a step boundary)
    sum: number
    count: number
  }
  const blocks: Block[] = []
  for (const s of sorted) {
    blocks.push({ x: s.confidence, sum: s.correct ? 1 : 0, count: 1 })
    // Merge while the last block violates monotonicity (its mean < previous mean).
    while (
      blocks.length >= 2 &&
      blocks[blocks.length - 1].sum / blocks[blocks.length - 1].count <
        blocks[blocks.length - 2].sum / blocks[blocks.length - 2].count
    ) {
      const b = blocks.pop()!
      const a = blocks.pop()!
      blocks.push({ x: Math.max(a.x, b.x), sum: a.sum + b.sum, count: a.count + b.count })
    }
  }

  const points = blocks.map((b) => ({ raw: b.x, calibrated: clamp01(b.sum / b.count) }))
  return { points, fittedOn: samples.length }
}

/**
 * Map a raw confidence to its calibrated probability using a fitted calibrator.
 * Step function: the calibrated value of the first block whose boundary is ≥ raw
 * (clamped to the ends). Monotonic by construction.
 */
export function calibrate(raw: number, calibrator: Calibrator): number {
  const r = clamp01(raw)
  const { points } = calibrator
  if (points.length === 0) return r
  for (const p of points) {
    if (r <= p.raw) return p.calibrated
  }
  return points[points.length - 1].calibrated
}

export type Band = 'auto' | 'suggest' | 'review'

export interface BandOptions {
  /** The transaction's absolute amount (SEK); large/unusual never auto-books. */
  amount?: number
  /** Above this the item is never auto-booked regardless of confidence (default 2000 kr). */
  autoBookAmountCap?: number
  /** Calibrated probability required to auto-book (default 0.95). */
  autoThreshold?: number
  /** Calibrated probability required to pre-fill as a suggestion (default 0.70). */
  suggestThreshold?: number
}

/**
 * Decide the band from a raw confidence, calibrating first when a calibrator is
 * available. Without a calibrator (not enough data), 'auto' is never returned:
 * an unproven score must not silently book.
 */
export function bandFor(
  rawConfidence: number,
  calibrator: Calibrator | null,
  opts: BandOptions = {},
): Band {
  const {
    amount,
    autoBookAmountCap = 2000,
    autoThreshold = 0.95,
    suggestThreshold = 0.7,
  } = opts

  const p = calibrator ? calibrate(rawConfidence, calibrator) : clamp01(rawConfidence)

  // Auto-book only with a real calibrator, a high calibrated probability, and a
  // small/routine amount. Any of those missing → at most a suggestion.
  if (
    calibrator &&
    p >= autoThreshold &&
    (amount === undefined || Math.abs(amount) <= autoBookAmountCap)
  ) {
    return 'auto'
  }
  if (p >= suggestThreshold) return 'suggest'
  return 'review'
}
