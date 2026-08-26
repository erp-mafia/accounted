/**
 * Four-digit calendar year, as used for räkenskapsår keys.
 *
 * ## Why this exists as its own name
 *
 * The regex is byte-identical to {@link ACCOUNT_NUMBER_RE} in
 * `account-number.ts`. That collision is the reason both are named: a reader
 * (or a codemod) scanning for `/^\d{4}$/` cannot tell a BAS account from a
 * year, and the two have opposite consequences when confused. `lib/api/schemas.ts`
 * already carried both meanings under the same literal.
 *
 * The bound is deliberately loose. Accounted holds historical räkenskapsår from
 * SIE imports going back decades and must accept future years for planning, so
 * this validates the shape and a sane range, not a business rule. Whether a
 * given year has an open fiscal period is a database question.
 */

/** Exactly four digits. Identical to the account-number shape by coincidence, not by meaning. */
export const FISCAL_YEAR_RE = /^\d{4}$/

/** Canonical validation error message (Swedish: user-facing surface). */
export const FISCAL_YEAR_MESSAGE = 'Nyckel måste vara ett fyrsiffrigt år'

/** Lower bound: earlier years are certainly a typo, not an imported räkenskapsår. */
export const FISCAL_YEAR_MIN = 1900

/** Upper bound: generous enough for forward planning, tight enough to catch a mistyped account number. */
export const FISCAL_YEAR_MAX = 2200

/** True when the input is four digits inside the accepted range. */
export function isFiscalYear(raw: string | number | null | undefined): boolean {
  if (raw === null || raw === undefined) return false
  const s = typeof raw === 'number' ? String(raw) : raw
  if (!FISCAL_YEAR_RE.test(s)) return false
  const n = parseInt(s, 10)
  return n >= FISCAL_YEAR_MIN && n <= FISCAL_YEAR_MAX
}
