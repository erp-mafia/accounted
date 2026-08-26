/**
 * BAS account number format.
 *
 * ## The rule
 *
 * Exactly four digits, carried as a **string**. `'1930'`, never `1930`.
 *
 * ## Why a string
 *
 * Account numbers are identifiers, not quantities. Arithmetic on one is always
 * a bug, and a numeric type invites it (`1930 + 1` is not an account). The
 * string form also keeps leading digits meaningful: the first digit is the BAS
 * account class (1 assets, 2 equity and liabilities, 3 revenue, 4-7 costs,
 * 8 financial), which reporting code reads positionally.
 *
 * ## Why the shared constant, not a literal
 *
 * `/^\d{4}$/` appeared at 20 sites, sometimes as `/^[0-9]{4}$/`, with error
 * messages that differed per site. Worse, the identical literal also means
 * "a four-digit year" elsewhere in the codebase (see `fiscal-year.ts`), so the
 * regex alone does not say what is being validated. Naming the rule makes the
 * two impossible to confuse at a call site.
 *
 * Format only. Whether an account *exists and is active* in a company's chart
 * is a database question: see `lib/bookkeeping/account-validation.ts`.
 */

/** Exactly four digits. */
export const ACCOUNT_NUMBER_RE = /^\d{4}$/

/** Canonical validation error message (Swedish: user-facing surface). */
export const ACCOUNT_NUMBER_MESSAGE = 'Kontonummer måste vara 4 siffror'

/** True when the input is a syntactically valid BAS account number. */
export function isAccountNumber(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && ACCOUNT_NUMBER_RE.test(raw)
}

/**
 * The BAS account class (leading digit) of an account number, or null when the
 * input is not a valid account number.
 */
export function accountClass(raw: string | null | undefined): number | null {
  if (!isAccountNumber(raw)) return null
  return parseInt((raw as string).charAt(0), 10)
}
