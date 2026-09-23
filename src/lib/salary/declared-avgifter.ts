import { truncateToWholeKronor } from '@/lib/money'

/**
 * Declared arbetsgivaravgifter: the whole-krona amount Skatteverket computes
 * from an AGI and draws from the skattekonto.
 *
 * Skatteverket does not use the filed FK487 for the beslut: it recomputes
 * the avgift (IK587, kontroll B_006 in Teknisk beskrivning §11.6.1) from the
 * declared per-IU underlag: per-IU underlag in whole kronor (öretal
 * bortfaller, SFF 2011:1261 22 kap. 1 §), summed per avgiftssats, the avgift
 * computed per sats on that sum with öretal dropped per sats, then summed.
 * An öre-exact per-employee sum truncated once at the end (or rounded, as
 * the old code did) drifts kronor away from that on any roster with
 * öre-bearing wages: 4 hourly employees at 30 000,99 kr give
 * 4 × roundOre(30 000,99 × 0,3142) = 37 705,24 → 37 705, while Skatteverket
 * computes trunc(4 × 30 000 × 0,3142) = 37 704 and draws 37 704.
 *
 * This module reproduces that computation so the AGI (FK487), the booked
 * 2731 liability, the stored declaration totals and the payment file all
 * carry the same number Skatteverket will draw.
 *
 * Two deliberate approximations, both öre/krona-scale and documented:
 *  - Per-IU underlag is truncateToWholeKronor(avgifter_basis) (one
 *    truncation of the summed basis) rather than the sum of the per-FIELD
 *    truncated FK011/FK012/… values Skatteverket sums. The two differ only
 *    when one employee has SEVERAL öre-bearing underlag components in the
 *    same month (e.g. örelön + bilförmån with öre), by at most k-1 kr for
 *    k öre-bearing components.
 *  - Cells are truncated per (category, sats) cell rather than per global
 *    sats. They differ by at most 1 kr, only when two categories share a
 *    sats with fractional products (e.g. växa-stöd reduced parts next to
 *    65+-reduced rows). In exchange the category breakdown always cross-foots
 *    exactly against the total.
 */

/**
 * F-skatt payees receive no skatteavdrag and form no underlag for
 * arbetsgivaravgifter (the AGI's isFSkattRow invariant). The single source
 * for that check: every booking/preview surface keys the exclusion on this
 * helper so the booked 2731/7510 split, the AGI's IU exclusion and the
 * previewed voucher cannot silently diverge for F-skatt employees.
 */
export function isFSkattStatus(status: string | null | undefined): boolean {
  return status === 'f_skatt'
}

/** One roster row, as stored on salary_run_employees. */
export interface DeclaredAvgifterRow {
  /**
   * Effective avgiftsunderlag in SEK (öre-exact): override-coalesced where
   * overrides apply, 0 for F-skatt rows (the engine already stores 0).
   */
  basis: number
  /** Stored avgifter_rate: the employee's (possibly reduced) sats. */
  rate: number
  /**
   * DB avgifter_category ('standard' | 'reduced_65plus' | 'youth' |
   * 'vaxa_stod' | 'exempt'), or null for legacy rows calculated before the
   * column existed (resolved by the same rate heuristic the AGI uses).
   */
  category: string | null
}

export interface DeclaredAvgifterParams {
  /** Full arbetsgivaravgift sats for above-cap parts (avgifterTotal). */
  standardRate: number
  /** Youth reduced-rate monthly cap (avgifterYouthSalaryCap), null = no cap. */
  youthCap: number | null
  /** Växa-stöd reduced-rate monthly cap (avgifterVaxaStodCap), null = no cap. */
  vaxaCap: number | null
}

/** AGI reporting category (växa-stöd and above-cap parts fold into standard). */
export type DeclaredAvgifterCategory = 'standard' | 'reduced65plus' | 'youth'

export interface DeclaredAvgifterCell {
  category: DeclaredAvgifterCategory
  /** Sats in hundredths of a percent (31,42 % = 3142). */
  rateHundredths: number
  /** Whole-krona underlag summed into this cell. */
  underlag: number
  /** Whole-krona avgift: trunc(underlag × sats). */
  amount: number
}

export interface DeclaredAvgifter {
  cells: DeclaredAvgifterCell[]
  /** Whole kronor: sum of cell underlag. */
  totalUnderlag: number
  /** Whole kronor: sum of cell amounts. This is what Skatteverket draws. */
  totalAmount: number
}

/**
 * Resolve the sats/cap parameters from a salary run's frozen
 * calculation_params snapshot (serializePayrollConfig shape). The 31,42 %
 * fallback only matters for pre-snapshot legacy runs.
 */
export function resolveDeclaredAvgifterParams(
  calculationParams: Record<string, unknown> | null | undefined,
): DeclaredAvgifterParams {
  const p = calculationParams ?? {}
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    standardRate: num(p['avgifterTotal']) ?? 0.3142,
    youthCap: num(p['avgifterYouthSalaryCap']),
    vaxaCap: num(p['avgifterVaxaStodCap']),
  }
}

/**
 * AGI reporting category for a roster row. Legacy rows (category null)
 * resolve by rate: at/below the 10,21/10,22 band → 65+-reduced, at/below
 * the 20,81/20,82 band → youth, else standard. Växa-stöd reports under
 * standard (its FK062/FK063 flags live on the IU, not the category map).
 */
export function reportingCategory(row: Pick<DeclaredAvgifterRow, 'rate' | 'category'>): DeclaredAvgifterCategory {
  switch (row.category) {
    case 'reduced_65plus':
      return 'reduced65plus'
    case 'youth':
      return 'youth'
    case 'vaxa_stod':
    case 'standard':
    // Exempt rows (born 1937 or earlier) carry rate 0 and never produce an
    // avgift; the explicit case only keeps the bucket label independent of
    // the rate heuristic.
    case 'exempt':
      return 'standard'
    default:
      return row.rate <= 0.1022 ? 'reduced65plus' : row.rate <= 0.2082 ? 'youth' : 'standard'
  }
}

function toRateHundredths(rate: number): number {
  return Math.round(rate * 10000)
}

/**
 * trunc(underlag × sats) in exact integer arithmetic: whole-krona underlag ×
 * sats-hundredths stays far below 2^53, so no float can shave a krona
 * (1000 × 0.007-style noise) or grant one.
 */
function truncatedAvgift(underlag: number, rateHundredths: number): number {
  return Math.trunc((underlag * rateHundredths) / 10_000)
}

export function computeDeclaredAvgifter(
  rows: DeclaredAvgifterRow[],
  params: DeclaredAvgifterParams,
): DeclaredAvgifter {
  // (category, sats) → underlag sum, in whole kronor.
  const cellUnderlag = new Map<string, { category: DeclaredAvgifterCategory; rateHundredths: number; underlag: number }>()
  const add = (category: DeclaredAvgifterCategory, rateHundredths: number, underlag: number) => {
    if (underlag <= 0 || rateHundredths <= 0) return
    const key = `${category}:${rateHundredths}`
    const cell = cellUnderlag.get(key) ?? { category, rateHundredths, underlag: 0 }
    cell.underlag += underlag
    cellUnderlag.set(key, cell)
  }

  const standardHundredths = toRateHundredths(params.standardRate)
  for (const row of rows) {
    const underlag = truncateToWholeKronor(row.basis)
    if (underlag <= 0) continue
    const rateHundredths = toRateHundredths(row.rate)
    if (rateHundredths <= 0) continue

    // Salary caps: the reduced sats applies up to the monthly cap, the
    // remainder is charged at the full sats: mirrors the engine's
    // youth/växa-stöd blend (calculation-engine.ts step 8), applied on the
    // declared whole-krona underlag the way Skatteverket applies it.
    // The youth cap keys on the RESOLVED category so a legacy null-category
    // row classified as youth by the rate heuristic still gets capped; växa
    // keys on the raw category (it resolves to 'standard' for reporting).
    const category = reportingCategory(row)
    const cap =
      category === 'youth' && params.youthCap !== null
        ? Math.trunc(params.youthCap)
        : row.category === 'vaxa_stod' && params.vaxaCap !== null
          ? Math.trunc(params.vaxaCap)
          : null
    if (cap !== null && underlag > cap) {
      add(category, rateHundredths, cap)
      add('standard', standardHundredths, underlag - cap)
    } else {
      add(category, rateHundredths, underlag)
    }
  }

  const cells: DeclaredAvgifterCell[] = [...cellUnderlag.values()].map((c) => ({
    category: c.category,
    rateHundredths: c.rateHundredths,
    underlag: c.underlag,
    amount: truncatedAvgift(c.underlag, c.rateHundredths),
  }))

  return {
    cells,
    totalUnderlag: cells.reduce((s, c) => s + c.underlag, 0),
    totalAmount: cells.reduce((s, c) => s + c.amount, 0),
  }
}

/**
 * Fold cells into the AGITotals.avgifterByCategory shape. Whole-krona values
 * that cross-foot exactly: sum of category amounts === totalAmount.
 */
export function declaredAvgifterByCategory(declared: DeclaredAvgifter): Partial<
  Record<DeclaredAvgifterCategory, { basis: number; amount: number }>
> {
  const byCategory: Partial<Record<DeclaredAvgifterCategory, { basis: number; amount: number }>> = {}
  for (const cell of declared.cells) {
    const entry = byCategory[cell.category] ?? { basis: 0, amount: 0 }
    entry.basis += cell.underlag
    entry.amount += cell.amount
    byCategory[cell.category] = entry
  }
  return byCategory
}

export interface DeclaredAvgifterHybridRow extends DeclaredAvgifterRow {
  /**
   * Öre-exact manual avgifter amount (avgifter_amount_override). When set,
   * this row bypasses the underlag computation entirely: the operator's
   * number is declared, booked and paid. Rows without it compute from
   * `basis` (the FILED underlag) like computeDeclaredAvgifter.
   */
  overrideAmount?: number | null
}

export interface DeclaredAvgifterWithOverrides {
  /** Whole kronor. What is filed as FK487, booked on 2731, and paid. */
  totalAmount: number
  /** Whole kronor. */
  totalUnderlag: number
  byCategory: Partial<Record<DeclaredAvgifterCategory, { basis: number; amount: number }>>
}

/**
 * The single declared-avgifter computation both the AGI generator and the
 * salary booking use, so the filed FK487, the stored declaration totals, the
 * booked 2731 liability and the payment are ONE number by construction.
 *
 * Rows without an override run Skatteverket's underlag computation
 * (computeDeclaredAvgifter): a manual adjustment on one employee must not
 * cost the rest of the roster its SKV-exact declared amount. Overridden rows
 * contribute their manual amounts summed per reporting category and
 * truncated per category. The category breakdown cross-foots exactly against
 * the total on every path.
 */
export function computeDeclaredAvgifterWithOverrides(
  rows: DeclaredAvgifterHybridRow[],
  params: DeclaredAvgifterParams,
): DeclaredAvgifterWithOverrides {
  const declared = computeDeclaredAvgifter(
    rows.filter((r) => r.overrideAmount == null),
    params,
  )
  const byCategory = declaredAvgifterByCategory(declared)
  let totalAmount = declared.totalAmount
  let totalUnderlag = declared.totalUnderlag

  const oreAmount = new Map<DeclaredAvgifterCategory, number>()
  const oreBasis = new Map<DeclaredAvgifterCategory, number>()
  for (const row of rows) {
    if (row.overrideAmount == null) continue
    const category = reportingCategory(row)
    oreAmount.set(category, (oreAmount.get(category) ?? 0) + row.overrideAmount)
    oreBasis.set(category, (oreBasis.get(category) ?? 0) + row.basis)
  }
  for (const [category, amountSum] of oreAmount) {
    const amount = truncateToWholeKronor(amountSum)
    const basis = truncateToWholeKronor(oreBasis.get(category) ?? 0)
    const entry = byCategory[category] ?? { basis: 0, amount: 0 }
    entry.amount += amount
    entry.basis += basis
    byCategory[category] = entry
    totalAmount += amount
    totalUnderlag += basis
  }

  return { totalAmount, totalUnderlag, byCategory }
}
