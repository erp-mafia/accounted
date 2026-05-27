/**
 * Centralized öre-precision rounding for bokslut and continuity logic.
 *
 * Swedish öresavrundning was abolished in 2010, but our journal entries
 * still store amounts in hundredths of SEK. Floating-point arithmetic
 * accumulates IEEE 754 drift, so all monetary calculations must funnel
 * through `roundOre()` before being compared, summed across rows, or
 * persisted as journal_entry_lines.
 *
 * Per CLAUDE.md accounting guard rail #9: never use `.toFixed()` for money.
 */

/**
 * Round a SEK amount to the nearest öre (two decimal places).
 *
 * Naive `Math.round(x * 100) / 100` fails on exact-half values like 1.005
 * because IEEE-754 stores 1.005 as 1.00499999…, so multiplying by 100
 * yields 100.49999… and Math.round drops it to 100 instead of 101.
 *
 * The Number.EPSILON nudge bridges the IEEE gap for double-precision
 * values near unit magnitude — large enough to push 100.49999… across
 * the half-integer boundary, small enough to leave well-formed decimals
 * (1.234, 1.235, etc.) untouched. Zero is special-cased so negative-zero
 * inputs preserve their sign through the round trip.
 */
export function roundOre(n: number): number {
  if (n === 0) return n
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Tolerance for comparing two öre-rounded amounts.
 *
 * Half an öre is the strictest meaningful threshold: any difference
 * larger than this represents a real one-öre discrepancy, not float
 * drift. Use for invariant assertions on closing entries, IB/UB
 * continuity per-account, and balance-sheet equality checks.
 *
 * Note: previously `continuity-check.ts` used 0.01 as its threshold.
 * That extra slack was meant to absorb drift from chained Math.round
 * calls, but with all rounding now centralized through `roundOre()`
 * the half-öre threshold is correct and tighter — a one-öre real
 * discrepancy must always surface.
 */
export const ORE_TOLERANCE = 0.005
