import type { AccountingMethod } from '@/types'

/**
 * The one rule for how a booking path gets the company's accounting method
 * (bokföringsmetod: faktureringsmetoden 'accrual' or kontantmetoden 'cash').
 *
 * The method decides the shape of a verifikat: under kontantmetoden an
 * invoice that was never booked is booked in full when it is paid (revenue or
 * cost plus moms against the bank), under faktureringsmetoden the payment only
 * clears 1510 or 2440. Before this module ~20 write paths read the setting,
 * ignored the read's error and fell back to 'accrual' when the value was
 * absent, so a transient read failure booked a kontantmetod invoice's payment as
 * Dr 1930 / Cr 1510: its revenue and utgående moms were never booked
 * (accounted#58, "Fail-open guards").
 *
 * company_settings.accounting_method is NOT NULL with a CHECK on the two
 * values, so a readable row always carries one. Anything else is a failed
 * read, a missing row or a column the caller forgot to select, and every one
 * of those refuses here instead of defaulting. The rule takes the read result
 * rather than issuing its own query because most callers read the method in
 * the same row as the other settings they need (vat_registered,
 * defer_invoice_booking, the last payment account).
 */

export const ACCOUNTING_METHODS = ['accrual', 'cash'] as const satisfies readonly AccountingMethod[]

/** The registry codes (lib/errors/structured-errors.ts) a refusal carries. */
export const ACCOUNTING_METHOD_UNREADABLE = 'SETTINGS_ACCOUNTING_METHOD_UNREADABLE'
export const ACCOUNTING_METHOD_MISSING = 'SETTINGS_ACCOUNTING_METHOD_MISSING'

export type AccountingMethodUnavailableCode =
  | typeof ACCOUNTING_METHOD_UNREADABLE
  | typeof ACCOUNTING_METHOD_MISSING

/**
 * - 'read_failed': the database answered with an error (transient: retry).
 * - 'missing': no settings row, or the value was not in the row read.
 * - 'invalid': a value outside the two methods.
 */
export type AccountingMethodUnavailableReason = 'read_failed' | 'missing' | 'invalid'

export class AccountingMethodUnavailableError extends Error {
  readonly code: AccountingMethodUnavailableCode
  readonly reason: AccountingMethodUnavailableReason

  constructor(reason: AccountingMethodUnavailableReason, detail?: string) {
    super(
      `The company's accounting method could not be determined (${reason})` +
        (detail ? `: ${detail}` : '') +
        '. Nothing was booked.',
    )
    this.name = 'AccountingMethodUnavailableError'
    this.reason = reason
    this.code = reason === 'read_failed' ? ACCOUNTING_METHOD_UNREADABLE : ACCOUNTING_METHOD_MISSING
  }

  /** The details a refusal envelope carries. */
  get details(): { reason: AccountingMethodUnavailableReason } {
    return { reason: this.reason }
  }
}

export function isAccountingMethod(value: unknown): value is AccountingMethod {
  return typeof value === 'string' && (ACCOUNTING_METHODS as readonly string[]).includes(value)
}

/** Narrow a stored value; throws instead of defaulting. */
export function parseAccountingMethod(value: unknown): AccountingMethod {
  if (isAccountingMethod(value)) return value
  throw new AccountingMethodUnavailableError(value == null ? 'missing' : 'invalid', value == null ? undefined : JSON.stringify(value))
}

/** A company_settings read as PostgREST answers it. */
export interface SettingsRead {
  data: unknown
  error: unknown
}

/**
 * The method from a company_settings read that selected `accounting_method`,
 * or a throw: a failed read, no row (`.single()` reports that as PGRST116)
 * and an unusable value never become 'accrual'.
 */
export function requireAccountingMethod(read: SettingsRead): AccountingMethod {
  if (read.error) {
    const pg = read.error as { code?: unknown; message?: unknown }
    if (pg.code === 'PGRST116') throw new AccountingMethodUnavailableError('missing')
    throw new AccountingMethodUnavailableError(
      'read_failed',
      typeof pg.message === 'string' ? pg.message : undefined,
    )
  }
  if (!read.data || typeof read.data !== 'object') throw new AccountingMethodUnavailableError('missing')
  return parseAccountingMethod((read.data as { accounting_method?: unknown }).accounting_method)
}

export type AccountingMethodCheck =
  | { ok: true; accountingMethod: AccountingMethod }
  | { ok: false; code: AccountingMethodUnavailableCode; details: { reason: AccountingMethodUnavailableReason }; error: AccountingMethodUnavailableError }

/** requireAccountingMethod for the paths that answer with a result instead of throwing. */
export function checkAccountingMethod(read: SettingsRead): AccountingMethodCheck {
  try {
    return { ok: true, accountingMethod: requireAccountingMethod(read) }
  } catch (err) {
    if (err instanceof AccountingMethodUnavailableError) {
      return { ok: false, code: err.code, details: err.details, error: err }
    }
    throw err
  }
}
