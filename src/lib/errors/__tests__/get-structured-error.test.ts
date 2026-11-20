import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { getStructuredError } from '../get-structured-error'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import { dbError } from '../db-error'
import { badArgument, codedRefusal } from '../refusal'
import { userFacing } from '../user-facing'

describe('getStructuredError', () => {
  it.each([
    [{ code: 'PT409', message: 'BANK_ANCHOR_SETTLEMENT_CHANGED' }, 'BANK_ANCHOR_SETTLEMENT_CHANGED'],
    [{ error: { code: 'PT409', message: 'BANK_ANCHOR_SETTLEMENT_CHANGED' } }, 'BANK_ANCHOR_SETTLEMENT_CHANGED'],
    [new BookkeepingDatabaseError('commit_entry', 'BANK_BOOKING_SOURCE_CHANGED', 'PT409'), 'BANK_BOOKING_SOURCE_CHANGED'],
  ])('names a bank refusal and requires refreshed input rather than an automatic retry', (error, code) => {
    expect(getStructuredError(error)).toMatchObject({ code, retryable: false })
  })

  it('keeps the generic conflict for an unregistered refusal name', () => {
    expect(getStructuredError({ code: 'PT409', message: 'SOME_UNREGISTERED_REFUSAL' })).toMatchObject({
      code: 'CONFLICT', retryable: false, message_sv: 'En konflikt uppstod. Ladda om sidan och försök igen.',
    })
  })

  it('marks a busy bank-account lock as retryable', () => {
    expect(getStructuredError({ code: 'PT409', message: 'CASH_ACCOUNT_OPERATION_BUSY' })).toMatchObject({
      code: 'CASH_ACCOUNT_OPERATION_BUSY', retryable: true,
    })
  })
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

  it('answers PERIOD_NOT_LOCKED with its remediation', () => {
    const result = getStructuredError(codedRefusal('PERIOD_NOT_LOCKED', 'Period must be locked before closing'))
    expect(result.code).toBe('PERIOD_NOT_LOCKED')
    expect(result.remediation?.tool).toBe('gnubok_lock_period')
  })

  // close_period / lock_period / run_year_end (MCP) and period-service throw
  // these coded. As plain strings they once fell through to UNKNOWN_ERROR with
  // "Något gick fel" (feedback seq 392722: close_period after run_year_end).
  it('answers PERIOD_ALREADY_CLOSED with the Swedish sentence and the way on', () => {
    const result = getStructuredError(codedRefusal('PERIOD_ALREADY_CLOSED', 'Period is already closed'))
    expect(result.code).toBe('PERIOD_ALREADY_CLOSED')
    expect(result.retryable).toBe(false)
    expect(result.message_sv).toMatch(/redan stängd/)
    expect(result.remediation?.description).toMatch(/gnubok_run_year_end/)
    expect(result.remediation?.tool).toBe('gnubok_list_fiscal_periods')
  })

  it('answers PERIOD_LOCK_ALREADY_LOCKED with the Swedish sentence and the way on', () => {
    const result = getStructuredError(codedRefusal('PERIOD_LOCK_ALREADY_LOCKED', 'Period is already locked'))
    expect(result.code).toBe('PERIOD_LOCK_ALREADY_LOCKED')
    expect(result.retryable).toBe(false)
    expect(result.message_sv).toBe('Perioden är redan låst.')
    expect(result.remediation?.description).toMatch(/do not lock first/)
    expect(result.remediation?.tool).toBe('gnubok_unlock_period')
  })

  it('maps an over-long reason to VALIDATION_ERROR with a specific Swedish message', () => {
    const result = getStructuredError(
      badArgument('reason', 'reason must be 500 characters or fewer', 'Motiveringen får vara högst 500 tecken.'),
    )
    expect(result.code).toBe('VALIDATION_ERROR')
    expect(result.message_sv).toBe('reason: Motiveringen får vara högst 500 tecken.')
  })

  it('answers a user-facing refusal with its code and its own sentence', () => {
    const sentence = 'Kan inte låsa period: 3 banktransaktion(er) i perioden saknar bokföring.'
    const result = getStructuredError(userFacing(new Error(sentence), 'PERIOD_HAS_UNBOOKED_TRANSACTIONS'))
    expect(result.code).toBe('PERIOD_HAS_UNBOOKED_TRANSACTIONS')
    expect(result.message_sv).toBe(sentence)
    expect(result.remediation?.tool).toBe('gnubok_list_uncategorized_transactions')
  })

  // A sentence is not a code: the throw site says what failed. The inference
  // table these replaced matched words ("already closed") that other
  // refusals also use.
  it.each([
    'Period must be locked before closing',
    'Period is already closed',
    'Kan inte låsa period: 3 affärstransaktion(er) saknar bokföring.',
    'Transaction already has a journal entry',
    'Invoice not found',
  ])('reads no code into the plain sentence %j', (sentence) => {
    expect(getStructuredError(new Error(sentence)).code).toBe('UNKNOWN_ERROR')
  })

  it.each([
    'Cannot write to locked/closed fiscal period "2025" (is_closed=t, locked_at=2026-01-31)',
    'Bokföringen är låst t.o.m. 2025-12-31. Kan inte skapa verifikation med datum 2025-11-03.',
  ])('names the database lock refusal %j PERIOD_LOCKED: triggers raise it as text', (sentence) => {
    expect(getStructuredError({ code: 'P0001', message: sentence }).code).toBe('PERIOD_LOCKED')
    expect(getStructuredError(new Error(`Database error: ${sentence}`)).code).toBe('PERIOD_LOCKED')
  })

  it('produces INSUFFICIENT_SCOPE remediation with attempted scope', () => {
    const result = getStructuredError(
      codedRefusal('INSUFFICIENT_SCOPE', 'Insufficient scope: this API key does not have the "bookkeeping:write" scope'),
      { attemptedScope: 'bookkeeping:write' }
    )
    expect(result.code).toBe('INSUFFICIENT_SCOPE')
    expect(result.remediation?.description).toContain('"bookkeeping:write"')
    expect(result.remediation?.resource).toBe('Accounted://capabilities')
  })

  it('points a key without approve at the review list in the app (issue #3408)', () => {
    const result = getStructuredError(
      codedRefusal('INSUFFICIENT_SCOPE', 'Insufficient scope: this API key does not have the "pending_operations:approve" scope'),
      { attemptedScope: 'pending_operations:approve' }
    )
    expect(result.code).toBe('INSUFFICIENT_SCOPE')
    expect(result.remediation?.description).toContain('"pending_operations:approve"')
    expect(result.remediation?.description).toContain('Att göra > Rutin')
    expect(result.remediation?.description).toContain('connects again with Godkänn ticked')
    // Scopes cannot be added to an existing key, so the generic hint is wrong here.
    expect(result.remediation?.description).not.toContain('add it to the existing key')
  })

  it('falls back to UNKNOWN_ERROR when no code or pattern matches', () => {
    const result = getStructuredError(new Error('Something weird happened'))
    expect(result.code).toBe('UNKNOWN_ERROR')
    expect(result.remediation).toBeUndefined()
  })

  it('handles plain string errors', () => {
    const result = getStructuredError('Period must be locked before closing')
    expect(result.code).toBe('UNKNOWN_ERROR')
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

  // A fetch that outlives AbortSignal.timeout rejects with the platform's own
  // error: a DOMException named TimeoutError, "The operation was aborted due
  // to timeout". No pattern knew that sentence, so twelve Skatteverket calls
  // on 2026-11-05 answered UNKNOWN_ERROR, not retryable, with those words.
  it('classifies the platform timeout as transient and says what to do', async () => {
    const signal = AbortSignal.timeout(1)
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    const timeout: unknown = signal.reason
    expect(timeout).toMatchObject({ name: 'TimeoutError', message: 'The operation was aborted due to timeout' })

    const result = getStructuredError(timeout)
    expect(result.code).toBe('TRANSIENT_ERROR')
    expect(result.retryable).toBe(true)
    expect(result.message_en).toBe(
      'A service this request depends on did not answer in time. Retry after a short wait; if the request changes something, first check whether it already went through.',
    )
    expect(result.message_sv).toBe('En tjänst som behövs för det här svarade inte i tid. Försök igen om en stund.')
  })

  it('keeps the words of a failure that wraps the platform timeout', () => {
    const result = getStructuredError(new Error('Bank sync failed: The operation was aborted due to timeout'))
    expect(result.code).toBe('TRANSIENT_ERROR')
    expect(result.retryable).toBe(true)
    expect(result.message_en).toBe('Bank sync failed: The operation was aborted due to timeout')
  })

  it('reads a timeout by its name, whatever it says', () => {
    const named = Object.assign(new Error('gave up waiting'), { name: 'TimeoutError' })
    expect(getStructuredError(named)).toMatchObject({ code: 'TRANSIENT_ERROR', retryable: true, message_en: 'gave up waiting' })
  })

  it('keeps a specific code but still computes retryable from the failure', () => {
    // NOT_FOUND is permanent even though nothing in the registry says so explicitly.
    const result = getStructuredError(codedRefusal('NOT_FOUND', 'Transaction not found'))
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
    const err = Object.assign(codedRefusal('PERIOD_NOT_LOCKED', 'Period must be locked before closing'), {
      remediation: { tool: 'gnubok_lock_period' }, // no description: not a hint
    })
    const result = getStructuredError(err)
    expect(result.code).toBe('PERIOD_NOT_LOCKED')
    expect(result.remediation?.tool).toBe('gnubok_lock_period')
    expect(result.remediation?.description).toBeTruthy()
  })
})

describe('getStructuredError: .single() with no row', () => {
  it('maps PGRST116 with 0 rows to NOT_FOUND, not retryable', () => {
    const err = dbError({
      code: 'PGRST116',
      message: 'Cannot coerce the result to a single JSON object',
      details: 'The result contains 0 rows',
    })
    const s = getStructuredError(err)
    expect(s.code).toBe('NOT_FOUND')
    expect(s.retryable).toBe(false)
    expect(s.message_sv).not.toMatch(/Något gick fel/)
    expect(s.message_en).toMatch(/no record with that id/)
  })

  it('maps PGRST116 without details to NOT_FOUND (the id-lookup shape)', () => {
    const s = getStructuredError({ code: 'PGRST116', message: 'Cannot coerce the result to a single JSON object' })
    expect(s.code).toBe('NOT_FOUND')
  })

  it('leaves PGRST116 with several rows alone: that is a query bug, not a missing record', () => {
    const s = getStructuredError({
      code: 'PGRST116',
      message: 'Cannot coerce the result to a single JSON object',
      details: 'The result contains 2 rows',
    })
    expect(s.code).not.toBe('NOT_FOUND')
  })
})

describe('getStructuredError: a ZodError that reached the dispatch', () => {
  // A `.parse()` that threw past its tool (create_skill, set_inbox_extracted_data)
  // answered UNKNOWN_ERROR with the raw issue JSON as message_en, while REST's
  // errorResponse has always called the same error VALIDATION_ERROR.
  const schema = z.object({ name: z.string(), steps: z.array(z.string().max(5)), days: z.number() }).strict()

  function zodErrorFor(input: unknown): z.ZodError {
    const parsed = schema.safeParse(input)
    if (parsed.success) throw new Error('expected a failure')
    return parsed.error
  }

  it('is VALIDATION_ERROR naming each path, never retryable', () => {
    const s = getStructuredError(zodErrorFor({ steps: ['too long'], days: 1 }))
    expect(s).toMatchObject({ code: 'VALIDATION_ERROR', retryable: false })
    expect(s.message_en).toMatch(/^Invalid arguments: name: .+; steps\.0: /)
  })

  it('renders each reason in Swedish, telling a missing field from a wrong type', () => {
    expect(getStructuredError(zodErrorFor({ steps: [], days: 'x' })).message_sv).toBe(
      'name: Obligatoriskt fält saknas. days: Fel typ: ska vara ett tal.',
    )
  })

  it('treats a thrown parse like the returned error', () => {
    let thrown: unknown
    try {
      schema.parse({ steps: [], days: 1 })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(z.ZodError)
    expect(getStructuredError(thrown)).toMatchObject({ code: 'VALIDATION_ERROR', message_sv: 'name: Obligatoriskt fält saknas.' })
  })

  it('keeps INTERNAL_ERROR for a parse of data the server built itself (the create_skill body shape)', () => {
    const s = getStructuredError(
      Object.assign(new Error('The skill body built from these arguments failed its own validation (a server bug): Line 3: use plain Markdown'), {
        code: 'INTERNAL_ERROR',
      }),
    )
    expect(s.code).toBe('INTERNAL_ERROR')
    expect(s.retryable).toBe(false)
  })
})
