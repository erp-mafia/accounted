/**
 * The database-error wrapper, and the classification it exists to unlock.
 *
 * The idiom `throw new Error(\`Database error: ${error.message}\`)` kept the
 * prose and dropped `code`. `isTransientFailure()` checks that SQLSTATE FIRST,
 * and 57014 (statement timeout) is already in its transient set, so stripping
 * it turned a retryable timeout into UNKNOWN_ERROR: "Något gick fel. Försök
 * igen." Agents cannot dispatch on that, so they retried: on production over
 * 60 days, 462 wasted repeat calls, with 53.1% of all real-agent error calls
 * sitting inside a repeat streak.
 *
 * The headline test is the last one: it asserts the OLD shape still resolves
 * to UNKNOWN_ERROR and the new one resolves to TRANSIENT_ERROR, so it fails if
 * the wrapper ever stops preserving the code.
 */
import { describe, it, expect } from 'vitest'
import { dbError, errorCauseTag } from '../db-error'
import { getStructuredError } from '../get-structured-error'

/** What supabase-js hands back when Postgres cancels on statement_timeout. */
const TIMEOUT_ERROR = {
  message: 'canceling statement due to statement timeout',
  code: '57014',
  details: null,
  hint: null,
}

describe('dbError', () => {
  it('preserves the SQLSTATE, which is the whole point', () => {
    const wrapped = dbError(TIMEOUT_ERROR)
    expect(wrapped.code).toBe('57014')
  })

  it('preserves details and hint for the server log', () => {
    const wrapped = dbError({
      message: 'duplicate key value violates unique constraint',
      code: '23505',
      details: 'Key (company_id, account_number) already exists.',
      hint: 'Use upsert.',
    })
    expect(wrapped.details).toContain('already exists')
    expect(wrapped.hint).toBe('Use upsert.')
  })

  it('never renders the literal "undefined"', () => {
    // A driver-level failure (aborted fetch, gateway timeout) can arrive with
    // no message at all. "Database error: undefined" is the string that made
    // these unsearchable in production.
    for (const shape of [{}, { message: undefined }, { message: '' }, { message: '   ' }, null]) {
      expect(dbError(shape).message).not.toContain('undefined')
    }
  })

  it('prefixes with the historical context by default', () => {
    expect(dbError({ message: 'boom' }).message).toBe('Database error: boom')
  })

  it('keeps the driver message verbatim when context is null', () => {
    // fetchAllRows passes null: callers such as query_journal's
    // sanitizeDbError already match on the exact text, and this change is
    // meant to add the code, not reword anything.
    expect(dbError({ message: 'boom' }, null).message).toBe('boom')
  })

  it('accepts a custom context', () => {
    expect(dbError({ message: 'boom' }, 'Database error resolving voucher "A-7"').message).toBe(
      'Database error resolving voucher "A-7": boom',
    )
  })
})

describe('errorCauseTag', () => {
  it('returns the SQLSTATE, which carries no tenant data', () => {
    expect(errorCauseTag(dbError(TIMEOUT_ERROR))).toBe('57014')
  })

  it('falls back to the error name when there is no code', () => {
    expect(errorCauseTag(new TypeError('nope'))).toBe('TypeError')
  })

  it('returns null rather than inventing a tag', () => {
    expect(errorCauseTag(new Error('plain'))).toBeNull()
    expect(errorCauseTag(null)).toBeNull()
  })
})

describe('classification: the regression this prevents', () => {
  it('classifies a wrapped statement timeout as retryable', () => {
    expect(getStructuredError(dbError(TIMEOUT_ERROR)).code).toBe('TRANSIENT_ERROR')
  })

  it('would classify the OLD bare-Error shape as UNKNOWN_ERROR', () => {
    // The bug, pinned. `new Error(error.message)` is what fetchAllRows threw,
    // and PostgREST does not always put the word "timeout" in the message it
    // returns, so message-pattern matching cannot be relied on. Only the code
    // is durable, which is why the wrapper must carry it.
    const stripped = new Error('some driver text that names no timeout')
    expect(getStructuredError(stripped).code).toBe('UNKNOWN_ERROR')

    // Same failure, code intact: now dispatchable.
    const preserved = dbError({ message: 'some driver text that names no timeout', code: '57014' })
    expect(getStructuredError(preserved).code).toBe('TRANSIENT_ERROR')
  })

  it('does not mistake a SQLSTATE for one of our own stable codes', () => {
    // extractCode() only accepts /^[A-Z_]+$/. Every SQLSTATE contains digits,
    // so attaching one cannot hijack the application error registry.
    expect(getStructuredError(dbError({ message: 'x', code: '23505' })).code).not.toBe('23505')
  })
})
