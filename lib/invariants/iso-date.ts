import { parseISO, isValid } from 'date-fns'

/**
 * ISO calendar date format (`YYYY-MM-DD`).
 *
 * ## The rule
 *
 * Accounting dates are exchanged and stored as `YYYY-MM-DD`, never as a locale
 * format and never as a timestamp. `lib/utils.ts` `formatDate()` renders this
 * same shape for display, so what a user reads matches what the API accepts.
 *
 * ## Why it is centralised
 *
 * The literal `/^\d{4}-\d{2}-\d{2}$/` appeared at 68 sites outside tests, with
 * at least three different error messages for the same failure ("Expected
 * YYYY-MM-DD", "Expected YYYY-MM-DD date format", "Ogiltigt datumformat
 * (YYYY-MM-DD)"). An API surface that rejects the same input three different
 * ways is three surfaces to a client.
 *
 * ## Two rules, not one
 *
 * - {@link isIsoDateShaped} is a **shape** check. `2026-02-31` passes it.
 * - {@link isSaneDateString} additionally requires the date to exist and to sit
 *   in a plausible year range. Use it for anything a human typed.
 *
 * `isSaneDateString` moved here from `lib/utils.ts`, where it was already
 * documented as "the ONE authoritative date rule shared by the client form and
 * the server-side CreateTransactionSchema". `lib/utils.ts` re-exports it so
 * existing imports keep working; this module is now its home because the same
 * rule is needed by consumers that must not import UI helpers.
 */

/** `YYYY-MM-DD` shape. Does not check that the date exists. */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Canonical validation error message. */
export const ISO_DATE_MESSAGE = 'Expected YYYY-MM-DD'

/** Swedish-facing variant, for surfaces that render errors to end users. */
export const ISO_DATE_MESSAGE_SV = 'Ogiltigt datumformat (YYYY-MM-DD)'

/** Message for the stricter {@link isSaneDateString} rule. */
export const SANE_DATE_MESSAGE = 'Invalid or out-of-range date (expected YYYY-MM-DD, year 1900-2100)'

/** Earliest year accepted for a user-entered date. */
export const SANE_DATE_MIN_YEAR = 1900

/** Latest year accepted for a user-entered date. */
export const SANE_DATE_MAX_YEAR = 2100

/** True when the input has `YYYY-MM-DD` shape. */
export function isIsoDateShaped(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && ISO_DATE_RE.test(raw)
}

/**
 * Strict ISO date validation for user-entered dates: correct shape, a date that
 * actually exists, and a plausible year.
 *
 * Rejects impossible dates (`2024-13-40`, `2026-02-31`) and absurd years. The
 * year bound exists because a mistyped or misparsed date most often lands far
 * outside it, and an accounting date in year 0202 silently creates a fiscal
 * period nobody can close.
 */
export function isSaneDateString(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false
  const d = parseISO(s)
  return isValid(d) && d.getFullYear() >= SANE_DATE_MIN_YEAR && d.getFullYear() <= SANE_DATE_MAX_YEAR
}
