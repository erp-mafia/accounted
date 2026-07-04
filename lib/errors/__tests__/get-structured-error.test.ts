import { describe, it, expect } from 'vitest'
import { getStructuredError } from '../get-structured-error'

describe('getStructuredError', () => {
  it('extracts code from structured bookkeeping error', () => {
    const result = getStructuredError({
      error: {
        code: 'JOURNAL_ENTRY_NOT_BALANCED',
        message: 'Debits do not match credits',
        details: { totalDebit: 100, totalCredit: 90 },
      },
    })
    expect(result.code).toBe('JOURNAL_ENTRY_NOT_BALANCED')
    expect(result.message_sv).toContain('balanserar inte')
    expect(result.message_en).toContain('Debits')
    expect(result.remediation?.description).toContain('Recalculate')
  })

  it('extracts code from typed error class with code property', () => {
    class FakeBookkeepingError extends Error {
      readonly code = 'ACCOUNTS_NOT_IN_CHART'
      readonly accountNumbers = ['1930', '2641']
      constructor() {
        super('Accounts not in chart')
      }
    }
    const result = getStructuredError(new FakeBookkeepingError())
    expect(result.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(result.remediation?.resource).toBe('Accounted://chart-of-accounts')
  })

  it('infers PERIOD_NOT_LOCKED from message text', () => {
    const result = getStructuredError(new Error('Period must be locked before closing'))
    expect(result.code).toBe('PERIOD_NOT_LOCKED')
    expect(result.remediation?.tool).toBe('gnubok_lock_period')
  })

  it('infers PERIOD_HAS_UNBOOKED_TRANSACTIONS from Swedish lock-error message', () => {
    const result = getStructuredError(
      new Error('Kan inte låsa period: 3 affärstransaktion(er) saknar bokföring.')
    )
    expect(result.code).toBe('PERIOD_HAS_UNBOOKED_TRANSACTIONS')
    expect(result.remediation?.tool).toBe('gnubok_list_uncategorized_transactions')
  })

  it('produces INSUFFICIENT_SCOPE remediation with attempted scope', () => {
    const result = getStructuredError(
      new Error('Insufficient scope: this API key does not have the "bookkeeping:write" scope'),
      { attemptedScope: 'bookkeeping:write' }
    )
    expect(result.code).toBe('INSUFFICIENT_SCOPE')
    expect(result.remediation?.description).toContain('"bookkeeping:write"')
    expect(result.remediation?.resource).toBe('Accounted://capabilities')
  })

  it('infers TRANSACTION_ALREADY_CATEGORIZED', () => {
    const result = getStructuredError(new Error('Transaction already has a journal entry'))
    expect(result.code).toBe('TRANSACTION_ALREADY_CATEGORIZED')
    expect(result.remediation?.tool).toBe('gnubok_uncategorize_transaction')
  })

  it('falls back to UNKNOWN_ERROR when no code or pattern matches', () => {
    const result = getStructuredError(new Error('Something weird happened'))
    expect(result.code).toBe('UNKNOWN_ERROR')
    expect(result.remediation).toBeUndefined()
  })

  it('handles plain string errors', () => {
    const result = getStructuredError('Period must be locked before closing')
    expect(result.code).toBe('PERIOD_NOT_LOCKED')
    expect(result.message_en).toBe('Period must be locked before closing')
  })

  it('handles null/undefined gracefully', () => {
    const result = getStructuredError(null)
    expect(result.code).toBe('UNKNOWN_ERROR')
    expect(result.message_en).toBe('Unknown error')
    expect(result.message_sv).toBeTruthy()
  })

  it('always returns Swedish message even with no match', () => {
    const result = getStructuredError(new Error('Random gibberish XYZ'))
    expect(result.message_sv).toBeTruthy()
    expect(result.message_sv.length).toBeGreaterThan(0)
  })
})

describe('retryable contract (always present, transient inference)', () => {
  it('is explicitly false for a plain unclassified error', () => {
    const result = getStructuredError(new Error('nope'))
    expect(result.code).toBe('UNKNOWN_ERROR')
    expect(result.retryable).toBe(false)
  })

  it('classifies a wrapped deadlock message as TRANSIENT_ERROR, retryable', () => {
    // Tools wrap DB errors as plain strings, losing the SQLSTATE: the
    // message pattern must survive that wrapping.
    const result = getStructuredError(new Error('Database error: deadlock detected'))
    expect(result.code).toBe('TRANSIENT_ERROR')
    expect(result.retryable).toBe(true)
  })

  it('classifies a Postgres serialization-failure SQLSTATE as transient', () => {
    const err = Object.assign(new Error('could not complete'), { code: '40001' })
    const result = getStructuredError(err)
    expect(result.code).toBe('TRANSIENT_ERROR')
    expect(result.retryable).toBe(true)
  })

  it('classifies upstream 429/503 statuses as transient', () => {
    expect(getStructuredError(Object.assign(new Error('slow down'), { status: 429 })).retryable).toBe(true)
    expect(getStructuredError(Object.assign(new Error('bad gateway'), { statusCode: 502 })).retryable).toBe(true)
  })

  it('classifies fetch/socket failures as transient', () => {
    expect(getStructuredError(new Error('fetch failed')).code).toBe('TRANSIENT_ERROR')
    expect(getStructuredError(new Error('socket hang up')).retryable).toBe(true)
    expect(getStructuredError(new Error('connect ECONNRESET 1.2.3.4:443')).retryable).toBe(true)
  })

  it('keeps a specific inferred code but still computes retryable from the failure', () => {
    // NOT_FOUND is permanent even though nothing in the registry says so explicitly.
    const result = getStructuredError(new Error('Transaction not found'))
    expect(result.code).toBe('NOT_FOUND')
    expect(result.retryable).toBe(false)
  })

  it('lets an explicit registry retryable:true win over inference', () => {
    const tagged = Object.assign(new Error('over the cap'), { code: 'RATE_LIMITED' })
    const result = getStructuredError(tagged)
    expect(result.retryable).toBe(true)
  })
})
