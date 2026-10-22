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
 * Round a SEK amount to the nearest whole krona, 50 öre up (Math.round's
 * half toward +∞, so -0,50 becomes 0, not -1).
 *
 * For recipients that ask for whole kronor without the tax rule that drops
 * öre: Fora's payAmount (lib/salary/fora) is an integer of the pay paid out
 * in the month, and nothing in Fora's specification truncates it. Anything
 * Skatteverket-bound uses truncateToWholeKronor instead.
 *
 * Runs through `roundOre` first so IEEE drift (31 249,4999… for a true
 * 31 249,50) cannot flip the krona. The -0 Math.round leaves on small
 * negatives is normalized to 0.
 */
export function roundToWholeKronor(n: number): number {
  const whole = Math.round(roundOre(n))
  return whole === 0 ? 0 : whole
}

/**
 * A percentage of an amount in whole kronor, öretal dropped: how every
 * percentage-based skatteavdrag is stated (SFF 2011:1261 22 kap. 1 §).
 * Computed in integer öre and hundredths of a percent: truncating the raw
 * float product would lose a whole krona when float noise lands an exact
 * result just below an integer (1000 × 0.007 === 6.999999999999999, so
 * 0.7 % of 1 000 kr would come out as 6 kr instead of 7 kr). Math.trunc, not
 * Math.floor: a negative amount (deductions exceeding pay) must not gain an
 * extra negative krona; the -0 it leaves on small negatives is normalized.
 */
export function wholeKronaPercentage(amount: number, percentage: number): number {
  const amountOre = Math.round(amount * 100)
  const percentageHundredths = Math.round(percentage * 100)
  const wholeKronor = Math.trunc((amountOre * percentageHundredths) / 1_000_000)
  return wholeKronor === 0 ? 0 : wholeKronor
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
 * The BAS account that absorbs öre rounding so a verifikat balances:
 * 3740 Öres- och kronutjämning (BAS 2026, lib/bookkeeping/bas-data/class-3-revenue.ts).
 *
 * Import this instead of spelling the number in each module: a literal has
 * nothing tying it to the catalogue, which is how the SIE importer booked its
 * rounding line on 3741, a number BAS does not have (#2687). The constant is
 * pinned to the catalogue entry by lib/__tests__/money.test.ts.
 */
export const ORE_ROUNDING_ACCOUNT = '3740'

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

/**
 * Parse a decimal number a person typed or pasted into a form field, as
 * written: no rounding. Returns null when the text is not one unambiguous
 * number, so a caller can tell "nothing usable typed" from zero. For money use
 * `parseAmountInput`, which rounds to the öre; this is for what keeps its
 * decimals (a quantity, a unit price, an exchange rate, a percentage).
 *
 * Accepts what Swedish users actually enter: space-grouped thousands
 * ("12 345,67"), including the non-breaking and narrow no-break spaces that
 * sv-SE formatting and copied bank statements carry (\s covers U+00A0 and
 * U+202F), a decimal comma or dot, and a Unicode minus (U+2212) as well as a
 * hyphen. When both a comma and a dot appear, the last one is the decimal and
 * the other must group whole thousands ("1.234,56", "1,234.56"); anything
 * else ambiguous ("1.234.567", "12,3,4") is refused rather than guessed, since
 * a wrong guess moves the amount by a factor of a thousand.
 *
 * `Number(s.replace(',', '.'))` is the bug this replaces: it turns
 * "12 345,67" into NaN, which call sites then read as 0.
 */
export function parseDecimalInput(input: string | null | undefined): number | null {
  if (input == null) return null
  return parseAmountText(input.replace(/\s/g, '').replace(/−/g, '-'), false)
}

/**
 * Parse an amount from a bank statement, a Skatteverket skattekonto export or
 * an opening-balance sheet: the one parser every file importer reads amounts
 * with, rounded to the öre. Returns null when the cell is not one amount.
 *
 * The same grammar as parseAmountInput, plus what files carry and a person
 * does not type: a Unicode minus or dash lookalike (U+2212, U+2010-U+2013) or
 * a leading plus as the sign, a trailing "kr", and dot-grouped thousands
 * without a decimal ("1.234", "1.234.567"), which a Swedish export means as
 * thousands. A number (a spreadsheet cell) is rounded as is.
 */
export function parseSwedishAmount(value: string | number | null | undefined): number | null {
  if (value == null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    const rounded = roundOre(value)
    return rounded === 0 ? 0 : rounded
  }
  const compact = value
    .replace(/\s/g, '')
    .replace(/kr$/i, '')
    .replace(/^[\u2212\u2010-\u2013]/, '-')
    .replace(/^\+/, '')
  const n = parseAmountText(compact, true)
  if (n === null) return null
  const rounded = roundOre(n)
  return rounded === 0 ? 0 : rounded
}

/**
 * The amount grammar both parsers share, on whitespace-free text: an optional
 * hyphen sign, digits, and at most one decimal mark. When both a comma and a
 * dot appear the last is the decimal and the other must group whole
 * thousands. `dotThousands` also reads a dot-only strict thousands grouping
 * ("1.234") as thousands rather than as a decimal.
 */
function parseAmountText(compact: string, dotThousands: boolean): number | null {
  if (dotThousands && /^-?\d{1,3}(\.\d{3})+$/.test(compact)) {
    return finishAmount(compact.split('.').join(''), '')
  }
  const lastSep = Math.max(compact.lastIndexOf(','), compact.lastIndexOf('.'))
  let whole = lastSep === -1 ? compact : compact.slice(0, lastSep)
  const fraction = lastSep === -1 ? '' : compact.slice(lastSep + 1)

  if (lastSep !== -1) {
    const groupSep = compact[lastSep] === ',' ? '.' : ','
    if (whole.includes(groupSep)) {
      const grouped = groupSep === '.' ? /^-?\d{1,3}(\.\d{3})+$/ : /^-?\d{1,3}(,\d{3})+$/
      if (!grouped.test(whole)) return null
      whole = whole.split(groupSep).join('')
    }
  }
  return finishAmount(whole, fraction)
}

function finishAmount(whole: string, fraction: string): number | null {
  if (!/^-?\d*$/.test(whole) || !/^\d*$/.test(fraction)) return null
  if (whole.replace('-', '') === '' && fraction === '') return null

  const n = Number(fraction ? `${whole}.${fraction}` : whole)
  if (!Number.isFinite(n)) return null
  return n === 0 ? 0 : n
}

/**
 * Parse an amount a person typed or pasted into a form field, rounded to the
 * öre with `roundOre`. Same grammar as `parseDecimalInput`; null when the text
 * is not one unambiguous amount.
 */
export function parseAmountInput(input: string | null | undefined): number | null {
  const n = parseDecimalInput(input)
  if (n === null) return null
  const rounded = roundOre(n)
  return rounded === 0 ? 0 : rounded
}

/**
 * Parse "14 000", "17 500,50", "17500.50", "-17500" → magnitude (absolute
 * value); null when not an amount. \s covers NBSP/thin-NBSP thousand
 * separators from sv-SE formatting. Sign is discarded: credit notes store
 * negative totals, and a user searching a belopp thinks in magnitudes.
 */
export function parseAmountTerm(term: string): number | null {
  const compact = term.replace(/\s/g, '').replace(',', '.')
  if (!/^-?\d+(\.\d{1,2})?$/.test(compact)) return null
  const value = Number(compact)
  return Number.isFinite(value) ? Math.abs(value) : null
}

const AMOUNT_INPUT_FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: false,
})

/**
 * An amount as the value of an amount field: rounded to the öre, two
 * decimals, no grouping, so `parseAmountInput` reads it back unchanged
 * ("1234,50"). `decimal` is ',' for the text fields Swedish users type into
 * and '.' for an <input type="number">, which only takes a dot. For an amount
 * shown rather than edited use `formatAmount` (lib/utils.ts).
 *
 * Replaces `n.toFixed(2)`, which rounds 1.005 down to "1.00" (the double
 * below 1.005) where `roundOre` gives 1.01.
 */
export function formatAmountInput(n: number, decimal: ',' | '.' = ','): string {
  const rounded = roundOre(n)
  const text = AMOUNT_INPUT_FORMAT.format(rounded === 0 ? 0 : rounded)
  return decimal === ',' ? text.replace('.', ',') : text
}
