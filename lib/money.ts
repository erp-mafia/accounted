/**
 * Canonical money primitives for Accounted.
 *
 * Swedish öresavrundning was abolished in 2010, but our journal entries still
 * store amounts in hundredths of SEK. Floating-point arithmetic accumulates
 * IEEE 754 drift, so all monetary calculations must funnel through `roundOre()`
 * before being compared, summed across rows, or persisted as
 * journal_entry_lines.
 *
 * Per CLAUDE.md accounting guard rail #9: never use `.toFixed()` for money, and
 * never hand-roll `Math.round(x * 100) / 100`: that naive form is subtly wrong
 * (see `roundOre` below). Import these helpers instead.
 *
 * This module is the single source of truth. `lib/bokslut/rounding.ts`
 * re-exports `roundOre`/`ORE_TOLERANCE` from here for back-compat; new code
 * should import from `@/lib/money`.
 */

/**
 * Round a SEK amount to the nearest öre (two decimal places).
 *
 * Naive `Math.round(x * 100) / 100` fails on exact-half values like 1.005
 * because IEEE-754 stores 1.005 as 1.00499999…, so multiplying by 100 yields
 * 100.49999… and Math.round drops it to 100 instead of 101.
 *
 * The Number.EPSILON nudge bridges the IEEE gap for double-precision values
 * near unit magnitude: large enough to push 100.49999… across the half-integer
 * boundary, small enough to leave well-formed decimals (1.234, 1.235, etc.)
 * untouched. Zero is special-cased so negative-zero inputs preserve their sign
 * through the round trip.
 */
export function roundOre(n: number): number {
  if (n === 0) return n
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Tolerance for comparing two öre-rounded amounts.
 *
 * Half an öre is the strictest meaningful threshold: any difference larger than
 * this represents a real one-öre discrepancy, not float drift. Use for
 * invariant assertions on closing entries, IB/UB continuity per-account, and
 * balance-sheet equality checks.
 */
export const ORE_TOLERANCE = 0.005

/**
 * Maximum |bank payment − invoice remaining| (in SEK) that is treated as
 * öresavrundning: booked to BAS 3740 (Öres- och kronutjämning) so the invoice
 * settles fully: rather than left as a genuine partial payment.
 *
 * Swedish whole-krona settlements (Bankgiro, Swish, kort) pay an öre-bearing
 * invoice total rounded to the nearest krona, so the residual is always strictly
 * under 1 krona. A real shortfall is ≥ 1 krona, so this band can never hide one.
 *
 * NOTE: deliberately looser than `ORE_TOLERANCE` (0,005). That constant is
 * float-equalisation; this is an accounting policy band. Keep them distinct:
 * never reuse `ORE_TOLERANCE` for settlement rounding.
 */
export const ORE_ROUNDING_SETTLEMENT_MAX = 1.0

/**
 * True when two amounts are equal to the öre (within `ORE_TOLERANCE`). Prefer
 * this over `a === b` for money: direct equality on floats fails on drift.
 */
export function equalOre(a: number, b: number): boolean {
  return Math.abs(a - b) <= ORE_TOLERANCE
}

/**
 * True when `n` is zero to the öre. Useful for "fully settled / balances"
 * checks where accumulated float drift would defeat `n === 0`.
 */
export function isZeroOre(n: number): boolean {
  return Math.abs(n) <= ORE_TOLERANCE
}

/**
 * Sum a list of SEK amounts with a single öre-round applied to the total.
 *
 * Rounding once at the end (rather than per addend) matches how a verifikat is
 * totalled and avoids compounding half-öre rounding across many lines.
 */
export function sumOre(values: readonly number[]): number {
  return roundOre(values.reduce((acc, v) => acc + v, 0))
}
