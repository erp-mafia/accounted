import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  captureException,
  captureMessage,
  flushObservability,
  getEnvironment,
  getObservabilitySink,
  getRelease,
  isObservabilityConfigured,
  noopSink,
  registerObservabilitySink,
  resetObservabilitySink,
  type ObservabilityContext,
  type ObservabilityLevel,
  type ObservabilitySink,
} from '../sink'

interface Captured {
  kind: 'exception' | 'message'
  error?: unknown
  message?: string
  level?: ObservabilityLevel
  context: ObservabilityContext
}

function makeFakeSink(): { sink: ObservabilitySink; events: Captured[]; flushes: number[] } {
  const events: Captured[] = []
  const flushes: number[] = []
  const sink: ObservabilitySink = {
    name: 'fake',
    captureException(error, context) {
      events.push({ kind: 'exception', error, context })
    },
    captureMessage(message, level, context) {
      events.push({ kind: 'message', message, level, context })
    },
    async flush(timeoutMs) {
      flushes.push(timeoutMs ?? -1)
      return true
    },
  }
  return { sink, events, flushes }
}

describe('observability sink', () => {
  beforeEach(() => {
    resetObservabilitySink()
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    resetObservabilitySink()
    vi.unstubAllEnvs()
  })

  it('defaults to the no-op sink and reports itself as unconfigured', () => {
    expect(getObservabilitySink()).toBe(noopSink)
    expect(isObservabilityConfigured()).toBe(false)
    // Must not throw with no provider installed.
    expect(() => captureException(new Error('boom'))).not.toThrow()
    expect(() => captureMessage('hello', 'error')).not.toThrow()
  })

  it('registers an adapter and routes events to it', () => {
    const { sink, events } = makeFakeSink()
    registerObservabilitySink(sink)

    expect(isObservabilityConfigured()).toBe(true)
    captureMessage('something happened', 'warning', { operation: 'test.op' })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'message',
      message: 'something happened',
      level: 'warning',
    })
    expect(events[0].context.operation).toBe('test.op')
  })

  it('resetObservabilitySink restores the no-op default', () => {
    const { sink, events } = makeFakeSink()
    registerObservabilitySink(sink)
    resetObservabilitySink()

    captureMessage('after reset', 'error')
    expect(events).toHaveLength(0)
    expect(isObservabilityConfigured()).toBe(false)
  })

  it('serializes Error instances before they reach the adapter', () => {
    const { sink, events } = makeFakeSink()
    registerObservabilitySink(sink)

    const err = new Error('database exploded')
    ;(err as Error & { code?: string }).code = '23505'
    captureException(err, { operation: 'test.op' })

    expect(events[0].error).not.toBeInstanceOf(Error)
    expect(events[0].error).toMatchObject({
      name: 'Error',
      message: 'database exploded',
      code: '23505',
    })
  })

  it('redacts denylisted keys in context before the adapter sees them', () => {
    const { sink, events } = makeFakeSink()
    registerObservabilitySink(sink)

    captureMessage('login failed', 'error', {
      user: 'alice',
      personnummer: '800101-1234',
      headers: { authorization: 'Bearer abc', cookie: 'sess=xyz' },
      nested: { payload: { password: 'hunter2', iban: 'SE1234567890' } },
    })

    const ctx = events[0].context as {
      user: string
      personnummer: string
      headers: { authorization: string; cookie: string }
      nested: { payload: { password: string; iban: string } }
    }
    expect(ctx.personnummer).toBe('[REDACTED]')
    expect(ctx.headers.authorization).toBe('[REDACTED]')
    expect(ctx.headers.cookie).toBe('[REDACTED]')
    expect(ctx.nested.payload.password).toBe('[REDACTED]')
    expect(ctx.nested.payload.iban).toBe('[REDACTED]')
    expect(ctx.user).toBe('alice')
  })

  it('redacts personnummer-shaped strings in messages, errors and context values', () => {
    const { sink, events } = makeFakeSink()
    registerObservabilitySink(sink)

    captureMessage('failed for 19800101-1234', 'error', { note: 'customer 800101-1234 blocked' })
    captureException(new Error('no match for 800101-1234'), { note: 'ok' })

    expect(events[0].message).toBe('[REDACTED]')
    expect((events[0].context as { note: string }).note).toBe('[REDACTED]')
    expect((events[1].error as { message: string }).message).toBe('[REDACTED]')
  })

  it('preserves UUIDs, which are not personnummer', () => {
    const { sink, events } = makeFakeSink()
    registerObservabilitySink(sink)

    captureMessage('ok', 'info', { companyId: '57484518-3409-4b29-9d23-5d22f08bda63' })
    expect(events[0].context.companyId).toBe('57484518-3409-4b29-9d23-5d22f08bda63')
  })

  it('stamps release, environment and runtime, and callers cannot override them', () => {
    vi.stubEnv('OBSERVABILITY_RELEASE', '')
    vi.stubEnv('NEXT_PUBLIC_BUILD_ID', 'abc123sha')
    vi.stubEnv('OBSERVABILITY_ENVIRONMENT', 'preview')

    const { sink, events } = makeFakeSink()
    registerObservabilitySink(sink)

    captureMessage('tagged', 'error', { release: 'spoofed', environment: 'spoofed' })

    expect(events[0].context.release).toBe('abc123sha')
    expect(events[0].context.environment).toBe('preview')
    expect(events[0].context.runtime).toBe('server')
  })

  it('reads the release from the same value next.config.ts inlines, with fallbacks', () => {
    vi.stubEnv('OBSERVABILITY_RELEASE', '')
    vi.stubEnv('NEXT_PUBLIC_BUILD_ID', '')
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '')
    expect(getRelease()).toBeNull()

    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'runtime-sha')
    expect(getRelease()).toBe('runtime-sha')

    vi.stubEnv('NEXT_PUBLIC_BUILD_ID', 'build-sha')
    expect(getRelease()).toBe('build-sha')

    vi.stubEnv('OBSERVABILITY_RELEASE', 'explicit')
    expect(getRelease()).toBe('explicit')
  })

  it('derives the environment from VERCEL_ENV when no override is set', () => {
    vi.stubEnv('OBSERVABILITY_ENVIRONMENT', '')
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(getEnvironment()).toBe('production')
  })

  it('never lets a throwing adapter escape into the caller', () => {
    registerObservabilitySink({
      name: 'broken',
      captureException() {
        throw new Error('provider down')
      },
      captureMessage() {
        throw new Error('provider down')
      },
      async flush() {
        throw new Error('provider down')
      },
    })

    expect(() => captureException(new Error('app error'))).not.toThrow()
    expect(() => captureMessage('app message', 'error')).not.toThrow()
  })

  it('flush returns true by default and false when the adapter rejects', async () => {
    expect(await flushObservability()).toBe(true)

    const { sink, flushes } = makeFakeSink()
    registerObservabilitySink(sink)
    expect(await flushObservability(500)).toBe(true)
    expect(flushes).toEqual([500])

    registerObservabilitySink({
      name: 'broken',
      captureException() {},
      captureMessage() {},
      async flush() {
        throw new Error('provider down')
      },
    })
    expect(await flushObservability()).toBe(false)
  })
})
