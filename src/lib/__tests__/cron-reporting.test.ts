/**
 * Cron failure reporting (lib/auth/cron.ts).
 *
 * Lives here rather than next to lib/auth/__tests__/cron.test.ts, which covers
 * the constant-time secret comparison and is left untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  CRON_REPORT_THROTTLE_MS,
  reportCronFailure,
  reportCronSuccess,
  resetCronReportingState,
  shouldReportCronFailure,
  verifyCronSecret,
} from '../auth/cron'
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
  resetCronReportingState()
  vi.unstubAllEnvs()
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
  resetCronReportingState()
  vi.unstubAllEnvs()
})

describe('shouldReportCronFailure', () => {
  it('reports the first failure by default', () => {
    expect(shouldReportCronFailure({ consecutiveFailures: 1, lastReportAt: null })).toBe(true)
  })

  it('waits for the threshold when one is given', () => {
    expect(
      shouldReportCronFailure({ consecutiveFailures: 2, lastReportAt: null, threshold: 3 }),
    ).toBe(false)
    expect(
      shouldReportCronFailure({ consecutiveFailures: 3, lastReportAt: null, threshold: 3 }),
    ).toBe(true)
  })

  it('throttles repeats inside the window and allows them after it', () => {
    const now = 1_000_000_000
    expect(
      shouldReportCronFailure({ consecutiveFailures: 5, lastReportAt: now - 1000, now }),
    ).toBe(false)
    expect(
      shouldReportCronFailure({
        consecutiveFailures: 5,
        lastReportAt: now - CRON_REPORT_THROTTLE_MS - 1,
        now,
      }),
    ).toBe(true)
  })
})

describe('reportCronFailure', () => {
  it('sends a message event with cron context when there is no error object', () => {
    reportCronFailure({ operation: 'cron.invoice-reminders', status: 500, reason: 'timeout' })

    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('message')
    expect(events[0].level).toBe('error')
    expect(events[0].context).toMatchObject({
      cron: true,
      alert: true,
      operation: 'cron.invoice-reminders',
      cronKind: 'run',
      status: 500,
      reason: 'timeout',
      consecutiveFailures: 1,
    })
  })

  it('sends an exception event when an error is supplied', () => {
    reportCronFailure({
      operation: 'cron.documents-verify',
      error: new Error('storage unreachable'),
      itemsTotal: 10,
      itemsFailed: 4,
    })

    expect(events[0].kind).toBe('exception')
    expect(events[0].error).toMatchObject({ name: 'Error', message: 'storage unreachable' })
    expect(events[0].context).toMatchObject({ itemsTotal: 10, itemsFailed: 4 })
  })

  it('throttles a storm of failures from one operation into a single event', () => {
    for (let i = 0; i < 500; i++) {
      reportCronFailure({ operation: 'cron.accruals', kind: 'item', reason: 'boom' })
    }
    expect(events).toHaveLength(1)
  })

  it('keeps different operations and kinds on separate throttles', () => {
    reportCronFailure({ operation: 'cron.a', kind: 'run' })
    reportCronFailure({ operation: 'cron.a', kind: 'auth' })
    reportCronFailure({ operation: 'cron.b', kind: 'run' })
    expect(events).toHaveLength(3)
  })

  it('reports again once the throttle window has passed, with a growing streak', () => {
    const t0 = 1_000_000_000
    reportCronFailure({ operation: 'cron.a', now: t0 })
    reportCronFailure({ operation: 'cron.a', now: t0 + 1000 })
    reportCronFailure({ operation: 'cron.a', now: t0 + CRON_REPORT_THROTTLE_MS + 1 })

    expect(events).toHaveLength(2)
    expect(events[0].context.consecutiveFailures).toBe(1)
    expect(events[1].context.consecutiveFailures).toBe(3)
  })

  it('reportCronSuccess clears the streak so the next outage reports fresh', () => {
    const t0 = 1_000_000_000
    reportCronFailure({ operation: 'cron.a', now: t0 })
    reportCronSuccess('cron.a')
    reportCronFailure({ operation: 'cron.a', now: t0 + 1000 })

    expect(events).toHaveLength(2)
    expect(events[1].context.consecutiveFailures).toBe(1)
  })

  it('evicts only the oldest tracked key at capacity, keeping live throttles intact', () => {
    const t0 = 1_000_000_000
    // Fill the map to MAX_TRACKED_CRON_KEYS (200 in lib/auth/cron.ts).
    for (let i = 0; i < 200; i++) {
      reportCronFailure({ operation: `cron.op-${i}`, now: t0 })
    }
    events.length = 0

    // A new key at capacity used to clear() the whole map; now it evicts the
    // single oldest entry (cron.op-0).
    reportCronFailure({ operation: 'cron.new', now: t0 + 1 })
    expect(events).toHaveLength(1)

    // cron.op-199's throttle survived: an in-progress storm stays damped
    // instead of re-reporting immediately after the map was cleared.
    reportCronFailure({ operation: 'cron.op-199', now: t0 + 2 })
    expect(events).toHaveLength(1)

    // cron.op-0 was the one evicted: its next failure reports from a fresh
    // streak rather than inheriting the old one.
    reportCronFailure({ operation: 'cron.op-0', now: t0 + 3 })
    expect(events).toHaveLength(2)
    expect(events[1].context).toMatchObject({
      operation: 'cron.op-0',
      consecutiveFailures: 1,
    })
  })

  it('redacts PII in the supplied context before it reaches the sink', () => {
    reportCronFailure({
      operation: 'cron.salary',
      context: { note: 'employee 800101-1234 skipped', token: 'abc123' },
    })

    const ctx = events[0].context as { note: string; token: string }
    expect(ctx.note).toBe('[REDACTED]')
    expect(ctx.token).toBe('[REDACTED]')
  })

  it('never throws, even when the sink is broken', () => {
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
    expect(() => reportCronFailure({ operation: 'cron.a' })).not.toThrow()
  })
})

describe('verifyCronSecret reporting', () => {
  function cronRequest(auth?: string): Request {
    return new Request('http://localhost/api/invoices/recurring/cron', {
      headers: auth ? { authorization: auth } : {},
    })
  }

  it('reports a missing CRON_SECRET, the config error that silently kills every job', () => {
    vi.stubEnv('CRON_SECRET', '')
    const result = verifyCronSecret(cronRequest('Bearer whatever'))

    expect(result?.status).toBe(401)
    expect(events).toHaveLength(1)
    expect(events[0].context).toMatchObject({
      cron: true,
      alert: true,
      cronKind: 'auth',
      status: 401,
      reason: 'secret_not_configured',
      operation: '/api/invoices/recurring/cron',
    })
  })

  it('reports a token mismatch, i.e. a rotated secret the scheduler still has', () => {
    vi.stubEnv('CRON_SECRET', 'correct-secret')
    const result = verifyCronSecret(cronRequest('Bearer stale-secret'))

    expect(result?.status).toBe(401)
    expect(events[0].context.reason).toBe('token_mismatch')
  })

  it('reports a missing authorization header', () => {
    vi.stubEnv('CRON_SECRET', 'correct-secret')
    verifyCronSecret(cronRequest())
    expect(events[0].context.reason).toBe('missing_authorization')
  })

  it('uses an explicit operation name when one is given', () => {
    vi.stubEnv('CRON_SECRET', 'correct-secret')
    verifyCronSecret(cronRequest('Bearer nope'), { operation: 'cron.invoice-reminders' })
    expect(events[0].context.operation).toBe('cron.invoice-reminders')
  })

  it('reports nothing on a successful auth, and clears the streak', () => {
    vi.stubEnv('CRON_SECRET', 'correct-secret')
    verifyCronSecret(cronRequest('Bearer wrong'))
    expect(events).toHaveLength(1)

    expect(verifyCronSecret(cronRequest('Bearer correct-secret'))).toBeNull()
    expect(events).toHaveLength(1)

    // Streak was cleared, so the next failure reports immediately rather than
    // being swallowed by the previous report's throttle window.
    verifyCronSecret(cronRequest('Bearer wrong'))
    expect(events).toHaveLength(2)
    expect(events[1].context.consecutiveFailures).toBe(1)
  })

  it('can be told not to report', () => {
    vi.stubEnv('CRON_SECRET', 'correct-secret')
    verifyCronSecret(cronRequest('Bearer wrong'), { report: false })
    expect(events).toHaveLength(0)
  })
})
