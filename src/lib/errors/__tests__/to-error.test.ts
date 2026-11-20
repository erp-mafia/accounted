/**
 * A thrown non-Error used to reach the log line and PostHog as
 * "Error: [object Object]" (errorResponse wrapped it as new Error(String(err))):
 * 3 of 3 such PostHog events after 2026-10-26 came from that wrapping.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toError } from '../to-error'
import { errorResponse } from '../get-structured-error'
import { createLogger } from '@/lib/logger'
import { redactedError } from '@/lib/observability/redact'
import {
  registerObservabilitySink,
  resetObservabilitySink,
  type ObservabilitySink,
} from '@/lib/observability/sink'

const POSTGREST_TIMEOUT = {
  message: 'canceling statement due to statement timeout',
  code: '57014',
  details: null,
  hint: null,
}

describe('toError', () => {
  it('returns an Error unchanged', () => {
    const err = new TypeError('boom')
    expect(toError(err)).toBe(err)
  })

  it('keeps a PostgREST error body\'s message, name and SQLSTATE', () => {
    const err = toError(POSTGREST_TIMEOUT)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('canceling statement due to statement timeout')
    expect(err.name).toBe('PostgrestError')
    expect(err.code).toBe('57014')
    expect(String(err)).not.toContain('[object Object]')
  })

  it('leaves PostgREST details out: they echo row values', () => {
    const err = toError({
      message: 'new row for relation "x" violates check constraint "x_amount_check"',
      code: '23514',
      details: 'Failing row contains (Anna Andersson, 1250.00)',
      hint: null,
    })
    expect(JSON.stringify({ ...err, message: err.message, stack: err.stack })).not.toContain('Anna Andersson')
  })

  it('reads GoTrue and nested provider shapes', () => {
    expect(toError({ code: 'over_email_send_rate_limit', msg: 'Email rate limit exceeded' }).message).toBe(
      'Email rate limit exceeded',
    )
    expect(toError({ error: { message: 'Overloaded' } }).message).toBe('Overloaded')
  })

  it('names only the keys of an object without a message', () => {
    expect(toError({ amount: 1250, counterparty: 'Anna Andersson' }).message).toBe(
      'Non-Error object captured (keys: amount, counterparty)',
    )
  })

  it('takes a string as its message and says what any other value was', () => {
    expect(toError('boom').message).toBe('boom')
    expect(toError(undefined).message).toBe('Non-Error value captured: undefined')
  })

  it('starts the stack at the caller with the real name and message', () => {
    const err = toError(POSTGREST_TIMEOUT)
    expect(err.stack?.split('\n')[0]).toBe('PostgrestError: canceling statement due to statement timeout')
    expect(err.stack).not.toMatch(/at toError\b/)
  })
})

describe('errorResponse: a thrown PostgREST error body reaches error tracking with its message', () => {
  let captured: unknown[] = []
  const sink: ObservabilitySink = {
    name: 'fake',
    captureException(error) {
      captured.push(error)
    },
    captureMessage() {},
    async flush() {
      return true
    },
  }

  beforeEach(() => {
    captured = []
    registerObservabilitySink(sink)
  })

  afterEach(() => {
    resetObservabilitySink()
  })

  it('an unidentified failure (500) logs the real message and code, not [object Object]', async () => {
    const res = errorResponse(
      { message: 'column x does not exist', code: '42703', details: null, hint: null },
      createLogger('test'),
      { requestId: 'req-1' },
    )
    expect(res.status).toBe(500)
    expect(captured).toHaveLength(1)
    // What the PostHog adapter builds from what the sink hands it.
    const sent = redactedError(captured[0])
    expect(sent.message).toBe('column x does not exist')
    expect(sent.name).toBe('PostgrestError')
    expect(sent.code).toBe('42703')
  })

  it('a classified failure logged at error level (statement timeout) keeps its message too', async () => {
    const res = errorResponse(POSTGREST_TIMEOUT, createLogger('test'), { requestId: 'req-1' })
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(captured).toHaveLength(1)
    expect(redactedError(captured[0]).message).toBe('canceling statement due to statement timeout')
  })
})
