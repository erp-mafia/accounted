/**
 * Shared constants and helpers for the duplicate-payment / SI-match guards
 * used by `/api/supplier-invoices/[id]/mark-paid` and
 * `/api/transactions/[id]/categorize`. Both guards look for a likely-matching
 * counterparty within a fuzzy amount + date window; keeping the thresholds in
 * one place makes them tunable as we learn from real false-positive rates.
 */

/** Acceptable amount drift (±) when matching a bank tx to an invoice amount. */
export const DUPLICATE_AMOUNT_TOLERANCE_PCT = 0.02

/** Date window (±days) around the payment / invoice date. */
export const DUPLICATE_DATE_WINDOW_DAYS = 60

/** Cap on supplier / merchant names before they enter an ILIKE pattern, to
 * bound query work and avoid pathological inputs degrading the index scan. */
const MAX_LIKE_NEEDLE_LENGTH = 200

/**
 * Escape LIKE/ILIKE wildcards (`%`, `_`, `\`) and truncate to a safe length
 * before embedding the value in an ILIKE pattern. SQL-injection is already
 * handled by Supabase's parameterization; this purely prevents silent
 * over-matching on names like "50% Off AB" and bounds DB work on long inputs.
 */
export function escapeLikePattern(value: string): string {
  const truncated = value.length > MAX_LIKE_NEEDLE_LENGTH
    ? value.slice(0, MAX_LIKE_NEEDLE_LENGTH)
    : value
  return truncated.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * Normalize a Swedish payment reference (OCR / fakturanummer) for equality
 * comparison. Banks emit references with varying separators ("2026-0042",
 * "2026 0042", "2026/0042"); the OCR-spec equality is over the digits only.
 * Returns "" for nullish/empty so callers can short-circuit without
 * branching.
 */
export function normalizeOcrReference(value: string | null | undefined): string {
  if (!value) return ''
  return value.replace(/\D/g, '')
}

/**
 * Legal-form words carry no identity: "AB" sits on half the supplier
 * register, and a bank feed never abbreviates a counterparty to its legal
 * form. Skipped when picking the needle so "AB Volvo" yields "volvo".
 */
const LEGAL_FORM_TOKENS = new Set([
  'ab', 'aktiebolag', 'aktiebolaget', 'publ',
  'hb', 'handelsbolag', 'handelsbolaget',
  'kb', 'kommanditbolag', 'kommanditbolaget',
  'ef', 'ek', 'ekonomisk', 'förening', 'föreningen',
  'ltd', 'limited', 'llc', 'inc', 'corp', 'co', 'plc',
  'gmbh', 'ag', 'ug', 'oy', 'oyj', 'as', 'asa', 'aps', 'bv', 'nv', 'sa', 'sarl', 'srl', 'spa',
  'the',
])

/** Everything that is not a letter or digit, Latin letters incl. åäö and accents (no `u` flag: ES2017 target). */
const NON_NAME_CHARS = /[^a-z0-9\u00C0-\u024F]/g

/**
 * The only shape a needle can have: letters and digits. That is what makes it
 * safe to embed in a PostgREST filter-DSL string (`.or('col.ilike.%x%,...')`),
 * where `,` `.` `(` `)` would otherwise inject a clause, and in an ILIKE
 * pattern, where `%` `_` `\` would otherwise widen the match.
 */
export const COUNTERPARTY_NEEDLE_SHAPE = /^[a-z0-9\u00C0-\u024F]+$/

/** A prefix of a token is still a valid `%needle%` probe; bounds index work. */
const MAX_NEEDLE_LENGTH = 40

/**
 * The search needle for a counterparty name as a bank feed writes it.
 *
 * WHY. Bank text abbreviates: the row that paid the Hi3G Access AB invoice
 * reads "HI3G" with merchant_name empty, and a `%Hi3G Access AB%` needle can
 * never hit it (issue #2299). What survives abbreviation is the FIRST
 * distinctive word ("Hi3G", "Telia", "Volvo"), so that is the SQL prefilter;
 * the full name is still scored in JS afterwards.
 *
 * RULE. Lower-case, split on whitespace, strip every non-letter/digit, drop
 * legal forms, take the first token of at least two characters. Two rather
 * than three because two-letter first tokens are initialisms a bank keeps
 * verbatim ("SJ", "3M", "DB Schenker"); skipping past them lands on a generic
 * second word ("Svenska"). Returns null when nothing usable remains ("AB",
 * "3 AB"): the caller logs the skipped guard rather than probing on nothing.
 */
export function counterpartyNeedle(name: string | null | undefined): string | null {
  if (!name) return null
  const tokens = name
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(NON_NAME_CHARS, ''))
    .filter((token) => token.length > 0 && !LEGAL_FORM_TOKENS.has(token))
  const needle = tokens.find((token) => token.length >= 2)
  if (!needle) return null
  const capped = needle.slice(0, MAX_NEEDLE_LENGTH)
  return COUNTERPARTY_NEEDLE_SHAPE.test(capped) ? capped : null
}

/**
 * The tokens of a counterparty name used for the in-JS ranking of a candidate
 * row (same normalisation as the needle, every token of three or more chars).
 */
export function counterpartySearchTerms(name: string | null | undefined): string[] {
  if (!name) return []
  return name
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(NON_NAME_CHARS, ''))
    .filter((token) => token.length > 2 && !LEGAL_FORM_TOKENS.has(token))
}

/**
 * ONE logic expression per currency sweep: the currency predicate AND the
 * counterparty probe, nested so the whole thing rides a single `or=` query
 * parameter.
 *
 * WHY ONE EXPRESSION. postgrest-js `.or()` appends a query parameter; calling
 * it twice on one chain sends `or=` twice, and whether PostgREST ANDs a
 * repeated key is a grammar this repo does not otherwise rely on. If it ever
 * kept only one, the currency clause would be gone and a foreign row would be
 * banded against a kronor figure. Nesting the two groups under one `and()`
 * inside one top-level `or()` (PostgREST nests logic operators; `or` with a
 * single child is valid) makes the guard independent of duplicate-key
 * semantics. Proven against a real PostgREST in
 * lib/invoices/__tests__/duplicate-payment-candidates.tool.test.ts.
 *
 * WHY IT IS SAFE TO INTERPOLATE. The needle is letters and digits only
 * (`COUNTERPARTY_NEEDLE_SHAPE`, re-checked here), so it cannot carry the DSL
 * characters `,` `.` `(` `)` or the LIKE wildcards. `currencyFilter` comes from
 * `currencyRowFilter()` over an ISO 4217 code validated by `planAmountSweeps`.
 * `*` is PostgREST's URL form of the LIKE `%` wildcard.
 */
export function counterpartySweepLogic(currencyFilter: string, needle: string): string {
  if (!COUNTERPARTY_NEEDLE_SHAPE.test(needle)) {
    throw new Error('counterpartySweepLogic: needle must be letters and digits only')
  }
  return `and(or(${currencyFilter}),or(merchant_name.ilike.*${needle}*,description.ilike.*${needle}*))`
}
