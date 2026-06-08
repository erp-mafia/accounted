import { NextResponse } from 'next/server'

// ============================================================================
// Error codes
// ============================================================================

export const ACCOUNTS_NOT_IN_CHART = 'ACCOUNTS_NOT_IN_CHART' as const
export const JOURNAL_ENTRY_NOT_BALANCED = 'JOURNAL_ENTRY_NOT_BALANCED' as const
export const FISCAL_PERIOD_NOT_FOUND = 'FISCAL_PERIOD_NOT_FOUND' as const
export const ENTRY_DATE_OUTSIDE_FISCAL_PERIOD = 'ENTRY_DATE_OUTSIDE_FISCAL_PERIOD' as const
export const JOURNAL_ENTRY_NOT_FOUND = 'JOURNAL_ENTRY_NOT_FOUND' as const
export const CANNOT_REVERSE_NON_POSTED = 'CANNOT_REVERSE_NON_POSTED' as const
export const CANNOT_CORRECT_NON_POSTED = 'CANNOT_CORRECT_NON_POSTED' as const
export const ENTRY_ALREADY_REVERSED = 'ENTRY_ALREADY_REVERSED' as const
export const CURRENCY_REVALUATION_ALREADY_EXISTS = 'CURRENCY_REVALUATION_ALREADY_EXISTS' as const
export const INVALID_MAPPING_RESULT = 'INVALID_MAPPING_RESULT' as const
export const BOOKKEEPING_DATABASE_ERROR = 'BOOKKEEPING_DATABASE_ERROR' as const
export const MEANINGLESS_CORRECTION = 'MEANINGLESS_CORRECTION' as const
export const NO_OPEN_PERIOD_FOR_DATE = 'NO_OPEN_PERIOD_FOR_DATE' as const
export const TARGET_PERIOD_CLOSED = 'TARGET_PERIOD_CLOSED' as const
export const TARGET_PERIOD_LOCKED = 'TARGET_PERIOD_LOCKED' as const

// ============================================================================
// AccountsNotInChartError — kept for back-compat (many existing call sites)
// ============================================================================

export class AccountsNotInChartError extends Error {
  readonly code = ACCOUNTS_NOT_IN_CHART
  readonly accountNumbers: string[]

  constructor(accountNumbers: string[]) {
    // Numeric-first sort so mixed-length BAS codes (rare but possible) order
    // by value rather than by UTF-16 code units — otherwise ['245', '1930']
    // would sort to ['1930', '245'] under the default string comparator,
    // confusing a user about which accounts to activate in Kontoplan.
    // Non-numeric tokens fall back to a stable string compare so the order
    // is fully deterministic for any input.
    const sorted = [...new Set(accountNumbers)].sort(compareAccountNumbers)
    super(`Accounts not enabled in chart of accounts: ${sorted.join(', ')}`)
    this.name = 'AccountsNotInChartError'
    this.accountNumbers = sorted
  }
}

function compareAccountNumbers(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  const aIsNum = Number.isFinite(na)
  const bIsNum = Number.isFinite(nb)
  if (aIsNum && bIsNum) {
    if (na !== nb) return na - nb
    // Same numeric value but different string (e.g. "0245" vs "245") —
    // break the tie deterministically by string.
    return a < b ? -1 : a > b ? 1 : 0
  }
  if (aIsNum) return -1
  if (bIsNum) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

export function isAccountsNotInChartError(err: unknown): err is AccountsNotInChartError {
  return err instanceof AccountsNotInChartError
}

// ============================================================================
// Semantic errors — carry structured data so getErrorMessage can format rich
// Swedish translations with amounts / period names / status.
// ============================================================================

export class JournalEntryNotBalancedError extends Error {
  readonly code = JOURNAL_ENTRY_NOT_BALANCED
  constructor(
    public readonly totalDebit: number,
    public readonly totalCredit: number,
    public readonly kind: 'draft' | 'correction' = 'draft'
  ) {
    super(`Journal entry is not balanced: debits (${totalDebit}) != credits (${totalCredit})`)
    this.name = 'JournalEntryNotBalancedError'
  }
}

export class FiscalPeriodNotFoundError extends Error {
  readonly code = FISCAL_PERIOD_NOT_FOUND
  constructor() {
    super('Fiscal period not found')
    this.name = 'FiscalPeriodNotFoundError'
  }
}

export class EntryDateOutsideFiscalPeriodError extends Error {
  readonly code = ENTRY_DATE_OUTSIDE_FISCAL_PERIOD
  constructor(
    public readonly entryDate: string,
    public readonly periodName: string,
    public readonly periodStart: string,
    public readonly periodEnd: string
  ) {
    super(
      `Entry date ${entryDate} is outside fiscal period "${periodName}" (${periodStart} - ${periodEnd})`
    )
    this.name = 'EntryDateOutsideFiscalPeriodError'
  }
}

export class JournalEntryNotFoundError extends Error {
  readonly code = JOURNAL_ENTRY_NOT_FOUND
  constructor() {
    super('Journal entry not found')
    this.name = 'JournalEntryNotFoundError'
  }
}

export class CannotReverseNonPostedError extends Error {
  readonly code = CANNOT_REVERSE_NON_POSTED
  constructor(public readonly currentStatus: string) {
    super('Can only reverse posted entries')
    this.name = 'CannotReverseNonPostedError'
  }
}

export class CannotCorrectNonPostedError extends Error {
  readonly code = CANNOT_CORRECT_NON_POSTED
  constructor(public readonly currentStatus: string) {
    super('Can only correct posted entries')
    this.name = 'CannotCorrectNonPostedError'
  }
}

export class EntryAlreadyReversedError extends Error {
  readonly code = ENTRY_ALREADY_REVERSED
  constructor() {
    super('Entry was already reversed by a concurrent operation')
    this.name = 'EntryAlreadyReversedError'
  }
}

export class CurrencyRevaluationAlreadyExistsError extends Error {
  readonly code = CURRENCY_REVALUATION_ALREADY_EXISTS
  constructor() {
    super('Currency revaluation already exists for this period')
    this.name = 'CurrencyRevaluationAlreadyExistsError'
  }
}

export type MeaninglessCorrectionReason =
  | 'net_zero_per_account'
  | 'identical_to_original'
  | 'no_date_change'

export class MeaninglessCorrectionError extends Error {
  readonly code = MEANINGLESS_CORRECTION
  constructor(public readonly reason: MeaninglessCorrectionReason) {
    super(
      reason === 'net_zero_per_account'
        ? 'Correction lines net to zero on every account — no economic event represented (BFL 5 kap. 5 §).'
        : reason === 'no_date_change'
          ? 'New date equals the current date — nothing to move.'
          : 'Correction lines are identical to the original entry — nothing to correct.'
    )
    this.name = 'MeaninglessCorrectionError'
  }
}

/**
 * Raised when a verifikation is moved (recordate) to a date that no fiscal
 * period covers. We do not auto-create periods on a correction.
 */
export class NoOpenPeriodForDateError extends Error {
  readonly code = NO_OPEN_PERIOD_FOR_DATE
  constructor(public readonly date: string) {
    super(`No fiscal period covers ${date}`)
    this.name = 'NoOpenPeriodForDateError'
  }
}

/**
 * Raised when the target date of a recordate falls in a closed fiscal year
 * (bokslut). A closed year cannot be reopened — the correction must be booked
 * in the current open period instead.
 */
export class TargetPeriodClosedError extends Error {
  readonly code = TARGET_PERIOD_CLOSED
  constructor(public readonly date: string) {
    super(`The fiscal period covering ${date} is closed`)
    this.name = 'TargetPeriodClosedError'
  }
}

/**
 * Raised when the target date of a recordate falls in a locked period or is
 * covered by the company-wide bookkeeping lock date. Carries the lock date so
 * the UI can offer an unlock affordance.
 */
export class TargetPeriodLockedError extends Error {
  readonly code = TARGET_PERIOD_LOCKED
  constructor(
    public readonly date: string,
    public readonly lockDate: string | null
  ) {
    super(
      `The fiscal period covering ${date} is locked${lockDate ? ` (lock date ${lockDate})` : ''}`
    )
    this.name = 'TargetPeriodLockedError'
  }
}

export class InvalidMappingResultError extends Error {
  readonly code = INVALID_MAPPING_RESULT
  constructor(
    public readonly debitAccount: string | null | undefined,
    public readonly creditAccount: string | null | undefined
  ) {
    super(
      `Invalid mapping result: debit_account="${debitAccount}", credit_account="${creditAccount}". Both must be non-empty.`
    )
    this.name = 'InvalidMappingResultError'
  }
}

// ============================================================================
// BookkeepingDatabaseError — single wrapper for all "Failed to <op>: <cause>"
// engine throws. The `operation` tag is preserved for logs; the cause string
// stays in `message` so period-lock / trigger messages can still be matched
// by regex patterns in get-error-message.ts.
// ============================================================================

export type BookkeepingOperation =
  | 'get_next_voucher_number'
  | 'resolve_account_ids'
  | 'create_draft_entry'
  | 'create_entry_lines'
  | 'commit_entry'
  | 'create_reversal_entry'
  | 'create_reversal_lines'
  | 'post_reversal_entry'
  | 'create_corrected_entry'
  | 'create_corrected_lines'
  | 'post_corrected_entry'
  | 'fetch_currency_receivables'
  | 'fetch_currency_payables'
  | 'check_existing_revaluation'

export class BookkeepingDatabaseError extends Error {
  readonly code = BOOKKEEPING_DATABASE_ERROR
  constructor(
    public readonly operation: BookkeepingOperation,
    public readonly cause: string | undefined
  ) {
    super(cause ? `Database operation "${operation}" failed: ${cause}` : `Database operation "${operation}" failed`)
    this.name = 'BookkeepingDatabaseError'
  }
}

// ============================================================================
// Type guard
// ============================================================================

/**
 * True if `err` is any typed bookkeeping error. Use this in inner catch blocks
 * that want to re-throw domain errors so the outer handler can translate them
 * via bookkeepingErrorResponse().
 */
export function isBookkeepingError(err: unknown): boolean {
  return (
    err instanceof AccountsNotInChartError ||
    err instanceof JournalEntryNotBalancedError ||
    err instanceof FiscalPeriodNotFoundError ||
    err instanceof EntryDateOutsideFiscalPeriodError ||
    err instanceof JournalEntryNotFoundError ||
    err instanceof CannotReverseNonPostedError ||
    err instanceof CannotCorrectNonPostedError ||
    err instanceof EntryAlreadyReversedError ||
    err instanceof CurrencyRevaluationAlreadyExistsError ||
    err instanceof InvalidMappingResultError ||
    err instanceof BookkeepingDatabaseError ||
    err instanceof MeaninglessCorrectionError ||
    err instanceof NoOpenPeriodForDateError ||
    err instanceof TargetPeriodClosedError ||
    err instanceof TargetPeriodLockedError
  )
}

// ============================================================================
// Response helpers
// ============================================================================

/**
 * Build a structured 400 response for AccountsNotInChartError.
 * Kept for back-compat with existing callers; new code should prefer
 * bookkeepingErrorResponse() which covers all typed bookkeeping errors.
 */
export function accountsNotInChartResponse(err: AccountsNotInChartError) {
  return NextResponse.json(
    {
      error: {
        code: err.code,
        message: `Följande konton behöver aktiveras: ${err.accountNumbers.join(', ')}`,
        // Dual-emit: top-level for legacy frontend callers, nested under
        // `details` to match the v1 envelope shape so a single client (MCP
        // or external) can read `error.details.account_numbers` regardless
        // of which categorize endpoint it hit.
        account_numbers: err.accountNumbers,
        details: { account_numbers: err.accountNumbers },
      },
    },
    { status: 400 }
  )
}

/**
 * Build a structured JSON response for any typed bookkeeping error.
 * Returns null if `err` is not a recognized bookkeeping error so callers can
 * fall through to their existing generic handling.
 *
 * Response shape: { error: { code, message, details? } }
 * HTTP status: 404 for *_NOT_FOUND, 409 for concurrent/duplicate conflicts,
 * 500 for BOOKKEEPING_DATABASE_ERROR, 400 otherwise.
 */
export function bookkeepingErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof AccountsNotInChartError) {
    return accountsNotInChartResponse(err)
  }

  if (err instanceof JournalEntryNotBalancedError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: {
            totalDebit: err.totalDebit,
            totalCredit: err.totalCredit,
            kind: err.kind,
          },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof FiscalPeriodNotFoundError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message } },
      { status: 404 }
    )
  }

  if (err instanceof EntryDateOutsideFiscalPeriodError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: {
            entryDate: err.entryDate,
            periodName: err.periodName,
            periodStart: err.periodStart,
            periodEnd: err.periodEnd,
          },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof JournalEntryNotFoundError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message } },
      { status: 404 }
    )
  }

  if (err instanceof CannotReverseNonPostedError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { currentStatus: err.currentStatus },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof CannotCorrectNonPostedError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { currentStatus: err.currentStatus },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof EntryAlreadyReversedError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message } },
      { status: 409 }
    )
  }

  if (err instanceof CurrencyRevaluationAlreadyExistsError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message } },
      { status: 409 }
    )
  }

  if (err instanceof InvalidMappingResultError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: {
            debitAccount: err.debitAccount,
            creditAccount: err.creditAccount,
          },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof MeaninglessCorrectionError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { reason: err.reason },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof NoOpenPeriodForDateError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { date: err.date },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof TargetPeriodClosedError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { date: err.date },
        },
      },
      { status: 409 }
    )
  }

  if (err instanceof TargetPeriodLockedError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { date: err.date, lockDate: err.lockDate },
        },
      },
      { status: 409 }
    )
  }

  if (err instanceof BookkeepingDatabaseError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { operation: err.operation },
        },
      },
      { status: 500 }
    )
  }

  return null
}
