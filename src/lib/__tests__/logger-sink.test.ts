/**
 * The logger -> observability sink bridge.
 *
 * The redaction assertions here are the load-bearing ones: these log records
 * carry personnummer and financial data, and the sink ships them to a third
 * party. If any of these fail, redaction is being bypassed on the way out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createLogger } from '../logger'
import {
  registerObservabilitySink,
  resetObservabilitySink,
  type ObservabilityContext,
  type ObservabilityLevel,
} from '../observability/sink'

interface Captured {
  kind: 'exception' | 'message'
  error?: unknown
  message?: string
  level?: ObservabilityLevel
  context: ObservabilityContext
}

let events: Captured[] = []

beforeEach(() => {
  events = []
  // The logger still writes to the console; keep the suite quiet.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  registerObservabilitySink({
    name: 'test',
    captureException(error, context) {
      events.push({ kind: 'exception', error, context })
    },
    captureMessage(message, level, context) {
      events.push({ kind: 'message', message, level, context })
    },
    async flush() {
      return true
    },
  })
})

afterEach(() => {
  resetObservabilitySink()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('logger -> observability sink', () => {
  it('forwards every error record with its bound context', () => {
    const log = createLogger('test/module', { requestId: 'req_1' }).child({ companyId: 'co_1' })
    const err = new Error('insert failed')
    ;(err as Error & { code?: string }).code = '23505'

    log.error('could not save entry', err, { operation: 'journal.commit' })

    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('exception')
    expect(events[0].error).toMatchObject({ name: 'Error', message: 'insert failed', code: '23505' })
    expect(events[0].context).toMatchObject({
      module: 'test/module',
      logLevel: 'error',
      logMessage: 'could not save entry',
      requestId: 'req_1',
      companyId: 'co_1',
      operation: 'journal.commit',
    })
  })

  it('forwards an error record with no Error object as a message', () => {
    const log = createLogger('m')
    log.error('something went wrong', { status: 500 })

    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('message')
    expect(events[0].message).toBe('something went wrong')
    expect(events[0].level).toBe('error')
    expect(events[0].context.status).toBe(500)
  })

  it('forwards alert-flagged info/warn at their own severity, not as error', () => {
    const log = createLogger('m')
    log.warn('tax table stale', { alert: true })
    log.info('backup finished late', { alert: true })

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ kind: 'message', level: 'warning' })
    expect(events[1]).toMatchObject({ kind: 'message', level: 'info' })
  })

  it('does not forward plain info/warn records', () => {
    const log = createLogger('m')
    log.info('routine')
    log.warn('mildly odd')
    expect(events).toHaveLength(0)
  })

  it('forwards info/warn records flagged alert: true', () => {
    const log = createLogger('m')
    log.warn('year-end omföring skipped', { alert: true, companyId: 'co_1' })

    expect(events).toHaveLength(1)
    expect(events[0].context).toMatchObject({ alert: true, logLevel: 'warn', companyId: 'co_1' })
  })

  it('honours alert: true bound on a child logger', () => {
    const log = createLogger('m').child({ alert: true })
    log.info('this must page someone')
    expect(events).toHaveLength(1)
    expect(events[0].context.alert).toBe(true)
  })

  // --- redaction: the sink must never receive PII ---------------------------

  it('strips a personnummer from the message before the sink sees it', () => {
    const log = createLogger('m')
    log.error('could not match payment for 800101-1234')

    expect(events).toHaveLength(1)
    expect(events[0].message).toBe('[REDACTED]')
    expect(events[0].context.logMessage).toBe('[REDACTED]')
    expect(JSON.stringify(events[0])).not.toContain('800101-1234')
  })

  it('strips a personnummer from context values and from the error message', () => {
    const log = createLogger('m')
    log.error('rot/rut lookup failed', new Error('no customer with 19800101-1234'), {
      note: 'belongs to 800101-1234',
      companyId: '57484518-3409-4b29-9d23-5d22f08bda63',
    })

    expect(events[0].context.note).toBe('[REDACTED]')
    expect((events[0].error as { message: string }).message).toBe('[REDACTED]')
    // UUIDs survive: they are identifiers, not personnummer.
    expect(events[0].context.companyId).toBe('57484518-3409-4b29-9d23-5d22f08bda63')
    expect(JSON.stringify(events[0])).not.toContain('800101-1234')
  })

  it('strips denylisted keys, however deeply nested, before the sink sees them', () => {
    const log = createLogger('m')
    log.error('provider call failed', {
      user: 'alice',
      personnummer: '800101-1234',
      iban: 'SE4550000000058398257466',
      headers: { authorization: 'Bearer super-secret', cookie: 'sess=abc' },
      body: { credentials: { password: 'hunter2', api_key: 'gnubok_sk_live_xyz' } },
    })

    const ctx = events[0].context as {
      user: string
      personnummer: string
      iban: string
      headers: { authorization: string; cookie: string }
      body: { credentials: unknown }
    }
    expect(ctx.personnummer).toBe('[REDACTED]')
    expect(ctx.iban).toBe('[REDACTED]')
    expect(ctx.headers.authorization).toBe('[REDACTED]')
    expect(ctx.headers.cookie).toBe('[REDACTED]')
    expect(ctx.body.credentials).toBe('[REDACTED]')
    expect(ctx.user).toBe('alice')

    const serialized = JSON.stringify(events[0])
    expect(serialized).not.toContain('super-secret')
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('gnubok_sk_live_xyz')
    expect(serialized).not.toContain('SE4550000000058398257466')
  })

  it('redacts PII carried in trailing details args', () => {
    const log = createLogger('m')
    log.error('legacy call', 'customer 800101-1234 not found', 42)

    expect(events[0].context.details).toEqual(['[REDACTED]', 42])
  })

  it('scrubs API keys, emails and IBANs from free-text messages, not just denylisted keys', () => {
    const log = createLogger('m')
    log.error('key gnubok_sk_live_secret1 for anna@example.com failed on SE4550000000058398257466')

    expect(events[0].message).toBe(
      'key [REDACTED_API_KEY] for [REDACTED_EMAIL] failed on [REDACTED_IBAN]',
    )
    const serialized = JSON.stringify(events[0])
    expect(serialized).not.toContain('gnubok_sk_live_secret1')
    expect(serialized).not.toContain('anna@example.com')
    expect(serialized).not.toContain('SE4550000000058398257466')
  })

  // --- stacks: the sink keeps them, production stdout drops them -------------

  it('in production the sink receives a stack while the stdout JSON line drops it', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const log = createLogger('m')
    log.error('insert failed', new Error('clean failure'))

    // Sink path: the error tracker only runs in production, so this is the
    // one environment where a missing stack would make every event ungroupable.
    const sinkErr = events[0].error as { message: string; stack?: string }
    expect(typeof sinkErr.stack).toBe('string')
    expect(sinkErr.stack).toContain('clean failure')

    // Stdout path: unchanged contract, production log lines stay stackless.
    const line = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    const parsed = JSON.parse(line) as { err: { message: string; stack?: unknown } }
    expect(parsed.err.message).toBe('clean failure')
    expect(parsed.err.stack).toBeUndefined()
  })

  it('the stack reaching the sink in production is redacted', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const log = createLogger('m')
    log.error('lookup failed', new Error('no customer with 800101-1234'))

    const sinkErr = events[0].error as { message: string; stack?: string }
    // The first stack line carries the message, so the whole-string
    // personnummer rule nukes the stack rather than leaking it.
    expect(sinkErr.message).toBe('[REDACTED]')
    expect(sinkErr.stack).toBe('[REDACTED]')
    expect(JSON.stringify(events[0])).not.toContain('800101-1234')
  })

  // --- resilience ----------------------------------------------------------

  it('keeps logging when the sink throws', () => {
    registerObservabilitySink({
      name: 'broken',
      captureException() {
        throw new Error('provider down')
      },
      captureMessage() {
        throw new Error('provider down')
      },
      async flush() {
        return false
      },
    })

    const log = createLogger('m')
    expect(() => log.error('still works', new Error('boom'))).not.toThrow()
    expect(console.error).toHaveBeenCalled()
  })

  it('is inert when no provider is registered', () => {
    resetObservabilitySink()
    const log = createLogger('m')
    expect(() => log.error('no sink installed', new Error('boom'))).not.toThrow()
    expect(events).toHaveLength(0)
  })
})
