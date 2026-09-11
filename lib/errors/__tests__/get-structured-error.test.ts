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

  // close_period / lock_period / run_year_end (MCP) and period-service throw
  // these as plain strings. They used to fall through to UNKNOWN_ERROR with
  // "Något gick fel" (feedback seq 392722: close_period after run_year_end).
  it('infers PERIOD_ALREADY_CLOSED from the plain "Period is already closed" throw', () => {
    const result = getStructuredError(new Error('Period is already closed'))
    expect(result.code).toBe('PERIOD_ALREADY_CLOSED')
    expect(result.retryable).toBe(false)
    expect(result.message_sv).toMatch(/redan stängd/)
    expect(result.remediation?.description).toMatch(/gnubok_run_year_end/)
    expect(result.remediation?.tool).toBe('gnubok_list_fiscal_periods')
  })

  it('infers PERIOD_LOCK_ALREADY_LOCKED from the plain "Period is already locked" throw', () => {
    const result = getStructuredError(new Error('Period is already locked'))
    expect(result.code).toBe('PERIOD_LOCK_ALREADY_LOCKED')
    expect(result.retryable).toBe(false)
    expect(result.message_sv).toBe('Perioden är redan låst.')
    expect(result.remediation?.description).toMatch(/do not lock first/)
    expect(result.remediation?.tool).toBe('gnubok_unlock_period')
  })

  it('maps an over-long reason to VALIDATION_ERROR with a specific Swedish message', () => {
    const result = getStructuredError(new Error('reason must be 500 characters or fewer'))
    expect(result.code).toBe('VALIDATION_ERROR')
    expect(result.message_sv).toBe('Motiveringen får vara högst 500 tecken.')
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

describe('getStructuredError: throw-site remediation', () => {
  it('lets a thrown error carry its own remediation over the registry entry', () => {
    // SI_CREATE_INVALID_INPUT has no registry remediation (it is shared with
    // the REST create route, where an MCP tool hint would be wrong), so the
    // inbox staging tool attaches the fix it knows at the throw site.
    const err = Object.assign(new Error('Extracted invoice has no usable total'), {
      code: 'SI_CREATE_INVALID_INPUT',
      remediation: {
        description: 'Set totals from the underlag, then retry.',
        tool: 'gnubok_set_inbox_extracted_data',
        args: { inbox_item_id: 'inbox-1' },
      },
    })
    const result = getStructuredError(err)
    expect(result.code).toBe('SI_CREATE_INVALID_INPUT')
    expect(result.remediation).toEqual({
      description: 'Set totals from the underlag, then retry.',
      tool: 'gnubok_set_inbox_extracted_data',
      args: { inbox_item_id: 'inbox-1' },
    })
    expect(result.retryable).toBe(false)
  })

  it('ignores a malformed throw-site remediation and keeps the registry one', () => {
    const err = Object.assign(new Error('Period must be locked before closing'), {
      remediation: { tool: 'gnubok_lock_period' }, // no description: not a hint
    })
    const result = getStructuredError(err)
    expect(result.code).toBe('PERIOD_NOT_LOCKED')
    expect(result.remediation?.tool).toBe('gnubok_lock_period')
    expect(result.remediation?.description).toBeTruthy()
  })
})

