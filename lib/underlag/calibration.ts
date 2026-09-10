/**
 * What a matcher score has actually meant.
 *
 * The score is a weighted heuristic; 0.8 in it is not "80 % right". The
 * proposals humans have already answered (pending_operations of type
 * attach_document_to_transaction, committed or rejected) carry the score
 * they were staged at, so precision per score interval can be read off them.
 * `scripts/calibrate-matcher.ts` writes those intervals to calibration.json;
 * this module turns a score into that measured probability.
 *
 * Isotonic in spirit: intervals are pooled with their neighbours until the
 * precision never decreases with the score, so a lucky sparse bin cannot
 * claim more than the bins around it. An interval with fewer than
 * MIN_BIN_SAMPLES answers is pooled too, whatever it says.
 */
import bins from './calibration.json'

export interface CalibrationBin {
  /** Inclusive lower bound of the score interval. */
  lo: number
  /** Exclusive upper bound, except the last bin which includes 1. */
  hi: number
  /** Answered proposals in the interval. */
  n: number
  /** Share of them the human approved. */
  precision: number
}

export interface CalibrationTable {
  generated_at: string | null
  source: string
  bins: CalibrationBin[]
}

export const MIN_BIN_SAMPLES = 20

/**
 * Pool adjacent violators: walk the bins upward and merge any bin whose
 * precision is lower than the one before it (or that is too thin to trust)
 * into its predecessor, weighting by sample count.
 */
export function makeMonotone(input: readonly CalibrationBin[]): CalibrationBin[] {
  const sorted = [...input].sort((a, b) => a.lo - b.lo)
  const out: CalibrationBin[] = []
  for (const bin of sorted) {
    out.push({ ...bin })
    while (out.length >= 2) {
      const last = out[out.length - 1]
      const prev = out[out.length - 2]
      const thin = last.n < MIN_BIN_SAMPLES || prev.n < MIN_BIN_SAMPLES
      if (!thin && last.precision >= prev.precision) break
      const n = prev.n + last.n
      const precision = n > 0 ? (prev.precision * prev.n + last.precision * last.n) / n : 0
      out.splice(out.length - 2, 2, { lo: prev.lo, hi: last.hi, n, precision })
    }
  }
  return out
}

let monotone: CalibrationBin[] | null = null

function table(): CalibrationBin[] {
  if (monotone) return monotone
  const raw = (bins as CalibrationTable).bins ?? []
  monotone = makeMonotone(raw)
  return monotone
}

/**
 * The measured probability that a pair at this score is right, or null when
 * nothing has been measured for it yet. Null is an honest answer and callers
 * must treat it as "unknown", never as zero or as the raw score.
 */
export function calibratedProbability(confidence: number, tableOverride?: readonly CalibrationBin[]): number | null {
  const t = tableOverride ? makeMonotone(tableOverride) : table()
  if (t.length === 0) return null
  for (const bin of t) {
    const last = bin === t[t.length - 1]
    if (confidence >= bin.lo && (confidence < bin.hi || (last && confidence <= bin.hi))) {
      return bin.n >= MIN_BIN_SAMPLES ? Math.round(bin.precision * 1000) / 1000 : null
    }
  }
  return null
}
