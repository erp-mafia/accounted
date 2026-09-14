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
 * (see `roundOre` below). Nudging it with `Number.EPSILON` is not a fix either:
 * EPSILON is a fixed absolute quantity (the gap above 1.0), while the
 * representation error it is meant to bridge grows with the magnitude of the
 * value, so from 2 SEK upward the nudge vanishes into the value it is added to.
 * Import these helpers instead.
 *
 * This module is the single source of truth. `lib/bokslut/rounding.ts`
 * re-exports `roundOre`/`ORE_TOLERANCE` from here for back-compat; new code
 * should import from `@/lib/money`.
 */

/**
 * Shift a double by `exp` decimal places without re-entering binary
 * arithmetic.
 *
 * The exponent is edited in the number's own shortest round-trip decimal
 * string, so 10.075 becomes exactly 1007.5. Multiplying by 100 instead would
 * reintroduce the representation error we are trying to step around: the
 * double nearest 10.075 times 100 is 1007.4999999999999.
 *
 * Only finite numbers may reach this: `String(NaN)` yields 'NaN', and
 * `Number('NaNe2')` is NaN, so callers guard first.
 */
function shiftDecimal(n: number, exp: number): number {
  const [mantissa, e] = String(n).split('e')
  return Number(`${mantissa}e${e ? Number(e) + exp : exp}`)
}

/**
 * Round a SEK amount to the nearest öre (two decimal places), half away from
 * zero for positive amounts and half toward positive infinity for negative
 * ones (see the negative rule below).
 *
 * Naive `Math.round(x * 100) / 100` fails on exact-half values like 1.005
 * because IEEE-754 stores 1.005 as 1.00499999…, so multiplying by 100 yields
 * 100.49999… and Math.round drops it to 100 instead of 101.
 *
 * The historical `Number.EPSILON` nudge only papered over that near unit
 * magnitude. EPSILON is the gap above 1.0, a fixed absolute quantity, but the
 * gap between neighbouring doubles doubles with every power of two. From 2 SEK
 * upward `n + Number.EPSILON === n` for almost every exact half, so the nudge
 * did not merely fall short, it did not survive the addition, and the helper
 * degenerated into the naive form above: 10.075 came back as 10.07 and 8.575
 * as 8.57. Instead of guessing at an additive correction, the shift is done in
 * the decimal domain (`shiftDecimal`), where an exact half is exactly a half
 * and `Math.round` decides it on the first try.
 *
 * Negative exact halves round toward positive infinity: `roundOre(-1.005)` is
 * -1.00, not -1.01. That is `Math.round`'s own asymmetry and it is deliberate,
 * pinned by a test. Symmetric away-from-zero rounding on negatives would move
 * credit notes and reversals by one öre relative to the invoices they cancel,
 * so changing it is a founder decision, not a refactor.
 *
 * Zero is special-cased so negative-zero inputs preserve their sign through the
 * round trip; non-finite inputs pass through untouched because the decimal
 * shift cannot represent them. A negative smaller than half an öre collapses to
 * a plain 0, not -0, so it can never surface as "-0,00 kr" in a report.
 */
export function roundOre(n: number): number {
  if (n === 0 || !Number.isFinite(n)) return n
  return shiftDecimal(Math.round(shiftDecimal(n, 2)), -2)
}

/**
 * Truncate a SEK amount to whole kronor, dropping the öre (öretal bortfaller:
 * the whole-krona rule in SFF 2011:1261 22 kap. 1 §).
 *
 * This is the amount rule for everything Skatteverket-bound: AGI XML fields,
 * the declared totals stored on agi_declarations, the skattekonto payment,
 * and the 2731 liability booked at salary time (whose öre remainder goes to
 * 3740 Öres- och kronutjämning). Truncation, not rounding: 16 073,84 kr is
 * declared and drawn as 16 073 kr.
 *
 * Runs through `roundOre` first so IEEE drift just below an integer
 * (16 073,9999999… for a true 16 074,00) cannot lose a whole krona.
 * Math.trunc, not Math.floor: dropping öre truncates toward zero, and a
 * negative amount must not gain an extra negative krona. The -0 that
 * Math.trunc leaves on small negatives is normalized to 0.
 */
export function truncateToWholeKronor(n: number): number {
  const whole = Math.trunc(roundOre(n))
  return whole === 0 ? 0 : whole
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
