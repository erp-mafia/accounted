/**
 * The VAT of a received document (a supplier invoice, or a self-billing
 * invoice a customer issued in our name), per rate, the way the document
 * states it.
 *
 * Rounding VAT per line and summing the rounded lines drifts from the
 * document, which computes the VAT on the beskattningsunderlag per rate
 * (ML 17 kap. 24 § p.9 and 11; EN 16931 BR-CO-17): SF-CE-202608 has lines of
 * 17 564,15 and -2 107,70 at 25 %, 4 391,04 + -526,92 = 3 864,12 per line
 * against 3 864,11 on the sum (crm#1367). The register then carries a
 * receivable or a payable one öre off the document, and every payment leaves
 * a residual somebody has to clear by hand.
 *
 * So the VAT of each rate is either the document's own figure (`stated`,
 * accepted within the per-line rounding a seller may have used) or the VAT on
 * the summed base, and that figure is spread back onto the lines, moving a
 * line at most one öre from its own rounding. The lines then sum to the
 * document's VAT, so every reader (the registration verifikat, the header,
 * credit notes, the reskontra) agrees without being taught anything.
 *
 * Invoices we issue ourselves keep the per-line rule (computeLineVat,
 * docs/decisions/2026-10/2026-10-21-one-invoice-line-vat-rule.md).
 *
 * Integer arithmetic throughout (öre times basis points): 12 % and 6 % have
 * no exact binary fraction, and a float half-öre would round the wrong way.
 * Imports nothing but lib/money so the browser editor shows the figures the
 * server books.
 */

export interface DocumentVatLine {
  /** The line's net amount in the document currency (whole öre). */
  lineTotal: number
  /** The VAT rate as a fraction (0.25). */
  rate: number
  /** A VAT amount the caller set for this line; it is kept as given. */
  overrideVat?: number | null
}

export interface StatedRateVat {
  /** The VAT rate as a fraction (0.25). */
  rate: number
  /** The VAT the document states for that rate. */
  vatAmount: number
}

export type DocumentVatSource = 'computed' | 'stated' | 'overrides'

export interface DocumentRateVat {
  rate: number
  base: number
  vat: number
  source: DocumentVatSource
}

export type DocumentVatMismatchReason =
  | 'outside_tolerance'
  | 'rate_not_on_lines'
  | 'rate_missing'
  | 'rate_has_overrides'
  | 'duplicate_rate'
  | 'cannot_spread'

export interface DocumentVatMismatch {
  ok: false
  code: 'VAT_BREAKDOWN_MISMATCH'
  details: {
    rate: number
    stated: number | null
    computed: number | null
    tolerance: number | null
    reason: DocumentVatMismatchReason
  }
}

export type DocumentVatResult =
  | { ok: true; lineVat: number[]; byRate: DocumentRateVat[] }
  | DocumentVatMismatch

const BP = 10000 // basis points per 1.0
const HALF = BP / 2

/** Whole öre of an amount already rounded to öre. */
function toOre(amount: number): number {
  return Math.round(amount * 100)
}

function fromOre(ore: number): number {
  return ore / 100
}

function rateBp(rate: number): number {
  return Math.round(rate * BP)
}

/** q / BP rounded half toward plus infinity: roundOre's rule on both signs. */
function roundHalfUp(q: number): number {
  return Math.floor((q + HALF) / BP)
}

/**
 * How far a document's stated VAT for one rate may sit from the VAT on its
 * summed base and still be the same VAT: a seller who rounded each of its
 * `lines` lines can land up to half an öre per line away, never less than an
 * öre and never more than 2 kr (the cap supplier-invoice-line-totals uses).
 */
export function statedVatTolerance(lines: number): number {
  return fromOre(statedVatToleranceOre(lines))
}

function statedVatToleranceOre(lines: number): number {
  return Math.min(Math.max(1, Math.floor(lines / 2)), 200)
}

function mismatch(
  rate: number,
  reason: DocumentVatMismatchReason,
  figures: { stated?: number | null; computed?: number | null; tolerance?: number | null } = {},
): DocumentVatMismatch {
  return {
    ok: false,
    code: 'VAT_BREAKDOWN_MISMATCH',
    details: {
      rate,
      stated: figures.stated ?? null,
      computed: figures.computed ?? null,
      tolerance: figures.tolerance ?? null,
      reason,
    },
  }
}

interface FreeLine {
  index: number
  lineOre: number
  /** Exact VAT in öre times BP. */
  q: number
  /** The line's own rounding, in öre. */
  own: number
}

/**
 * Move `delta` öre over the lines, one öre per line, largest remainder first:
 * up onto the lines that rounded down the most, down off the lines that
 * rounded up the most. Ties go to the larger line, then the earlier one. A
 * line never moves to 0 or across its own sign: a stored 0 reads as "no VAT
 * stored" (rowInputVat recomputes it), and a positive line cannot carry
 * negative VAT. Returns false when the lines cannot take the whole delta.
 */
function spread(lines: FreeLine[], vat: number[], delta: number): boolean {
  if (delta === 0) return true
  const step = delta > 0 ? 1 : -1
  const eligible = lines.filter((line) => {
    const next = line.own + step
    if (next === 0) return false
    return line.lineOre > 0 ? next > 0 : next < 0
  })
  eligible.sort((a, b) => {
    const ra = a.q - BP * a.own
    const rb = b.q - BP * b.own
    if (ra !== rb) return step > 0 ? rb - ra : ra - rb
    const size = Math.abs(b.lineOre) - Math.abs(a.lineOre)
    if (size !== 0) return size
    return a.index - b.index
  })
  const count = Math.abs(delta)
  if (eligible.length < count) return false
  for (let k = 0; k < count; k++) {
    const line = eligible[k]
    vat[line.index] = fromOre(line.own + step)
  }
  return true
}

/**
 * The VAT of every line, so that each rate sums to the document's VAT for it.
 *
 * - A line with `overrideVat` keeps it, and a rate whose lines all carry one
 *   is reported as `overrides`.
 * - Without `stated`, each rate's VAT is the VAT on its summed base.
 * - With `stated`, it must name every rate above 0 that lines without an
 *   override carry, and only those; each figure must sit within
 *   statedVatTolerance of the VAT on the summed base. Anything else is a
 *   VAT_BREAKDOWN_MISMATCH, never a silent correction.
 * - A 0 % line carries 0, and a stated 0 % rate must state 0.
 */
export function allocateDocumentVat(
  lines: ReadonlyArray<DocumentVatLine>,
  stated?: ReadonlyArray<StatedRateVat> | null,
): DocumentVatResult {
  const vat: number[] = new Array(lines.length).fill(0)
  const groups = new Map<number, { rate: number; free: FreeLine[]; overrideOre: number; overrides: number; baseOre: number }>()

  lines.forEach((line, index) => {
    const bp = rateBp(line.rate)
    const lineOre = toOre(line.lineTotal)
    let group = groups.get(bp)
    if (!group) {
      group = { rate: line.rate, free: [], overrideOre: 0, overrides: 0, baseOre: 0 }
      groups.set(bp, group)
    }
    group.baseOre += lineOre
    if (line.overrideVat != null) {
      vat[index] = fromOre(toOre(line.overrideVat))
      group.overrideOre += toOre(line.overrideVat)
      group.overrides += 1
      return
    }
    if (bp === 0) return
    const q = lineOre * bp
    const own = roundHalfUp(q)
    vat[index] = fromOre(own)
    group.free.push({ index, lineOre, q, own })
  })

  const statedByBp = new Map<number, StatedRateVat>()
  for (const entry of stated ?? []) {
    const bp = rateBp(entry.rate)
    if (statedByBp.has(bp)) return mismatch(entry.rate, 'duplicate_rate', { stated: entry.vatAmount })
    statedByBp.set(bp, entry)
    if (bp === 0) {
      if (toOre(entry.vatAmount) !== 0) return mismatch(entry.rate, 'outside_tolerance', { stated: entry.vatAmount, computed: 0, tolerance: 0 })
      continue
    }
    const group = groups.get(bp)
    if (!group) return mismatch(entry.rate, 'rate_not_on_lines', { stated: entry.vatAmount })
    if (group.free.length === 0 || group.overrides > 0) {
      return mismatch(entry.rate, 'rate_has_overrides', { stated: entry.vatAmount })
    }
  }

  const byRate: DocumentRateVat[] = []
  const ordered = [...groups.entries()].sort(([a], [b]) => b - a)
  for (const [bp, group] of ordered) {
    if (group.free.length === 0) {
      // A 0 % rate, or a rate whose every line carries the caller's VAT.
      byRate.push({
        rate: group.rate,
        base: fromOre(group.baseOre),
        vat: fromOre(group.overrideOre),
        source: bp === 0 ? 'computed' : 'overrides',
      })
      continue
    }
    const freeBaseQ = group.free.reduce((sum, line) => sum + line.q, 0)
    const computedOre = roundHalfUp(freeBaseQ)
    const ownSum = group.free.reduce((sum, line) => sum + line.own, 0)
    const statedEntry = statedByBp.get(bp)

    let targetOre = computedOre
    let source: DocumentVatSource = 'computed'
    if (statedByBp.size > 0) {
      if (!statedEntry) return mismatch(group.rate, 'rate_missing', { computed: fromOre(computedOre) })
      const statedOre = toOre(statedEntry.vatAmount)
      const toleranceOre = statedVatToleranceOre(group.free.length)
      if (Math.abs(statedOre - computedOre) > toleranceOre) {
        return mismatch(group.rate, 'outside_tolerance', {
          stated: statedEntry.vatAmount,
          computed: fromOre(computedOre),
          tolerance: fromOre(toleranceOre),
        })
      }
      targetOre = statedOre
      source = 'stated'
    }

    if (!spread(group.free, vat, targetOre - ownSum)) {
      if (source === 'stated') {
        return mismatch(group.rate, 'cannot_spread', { stated: fromOre(targetOre), computed: fromOre(computedOre) })
      }
      // The lines cannot take the summed-base VAT one öre each without one
      // reaching 0 or flipping sign (lines of a few öre): keep each line's own
      // rounding rather than book VAT a line cannot carry.
      for (const line of group.free) vat[line.index] = fromOre(line.own)
      targetOre = ownSum
    }

    byRate.push({
      rate: group.rate,
      base: fromOre(group.baseOre),
      vat: fromOre(targetOre + group.overrideOre),
      source,
    })
  }

  return { ok: true, lineVat: vat, byRate }
}

/** The extracted document fields statedVatFromExtraction reads. */
export interface ExtractedDocumentVat {
  vatBreakdown?: ReadonlyArray<{ rate?: unknown; amount?: unknown }> | null
  totals?: { vatAmount?: unknown } | null
}

/**
 * The per-rate VAT an extracted document states, for the rates its lines
 * carry: the document's VAT breakdown (percent rates), else its single VAT
 * total when every line above 0 % carries the same rate. Null when the
 * document states nothing usable; the caller then computes on the sum.
 */
export function statedVatFromExtraction(
  extracted: ExtractedDocumentVat | null | undefined,
  lineRates: ReadonlyArray<number>,
): StatedRateVat[] | null {
  if (!extracted) return null
  const positiveRates = [...new Set(lineRates.filter((rate) => rate > 0).map(rateBp))]
  if (positiveRates.length === 0) return null

  const breakdown = (extracted.vatBreakdown ?? [])
    .map((entry) => {
      const rateValue = Number(entry.rate)
      const amount = Number(entry.amount)
      if (!Number.isFinite(rateValue) || !Number.isFinite(amount) || rateValue <= 0) return null
      const fraction = rateValue > 1 ? rateValue / 100 : rateValue
      return { rate: fraction, vatAmount: amount }
    })
    .filter((entry): entry is StatedRateVat => entry !== null)
  if (breakdown.length > 0) {
    const stated = positiveRates.map((bp) => breakdown.find((entry) => rateBp(entry.rate) === bp))
    if (stated.every((entry): entry is StatedRateVat => entry !== undefined)) {
      return stated.map((entry) => ({ rate: entry.rate, vatAmount: entry.vatAmount }))
    }
    return null
  }

  const total = Number(extracted.totals?.vatAmount)
  if (positiveRates.length === 1 && Number.isFinite(total) && extracted.totals?.vatAmount != null) {
    return [{ rate: positiveRates[0] / BP, vatAmount: total }]
  }
  return null
}
