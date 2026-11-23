/**
 * What leaves the browser when an error is captured, judged on the real
 * posthog-js rather than a mock: the SDK turns the thrown value into its own
 * $exception event, and that event is what must arrive redacted.
 *
 * The real SDK starts in node with one minimal window for the whole file:
 * posthog-js and its exception autocapture extension (which a browser loads
 * lazily, and which is loaded up front here, fetching nothing) keep the window
 * they found when they were first loaded, so every test shares that window and
 * one SDK instance, started by the first initAnalytics() with its real config.
 * posthog.init is wrapped only to put a recorder after the hooks that config
 * sets: the recorder keeps what would be sent and drops it, so nothing goes
 * anywhere. client.ts and early-errors.ts are fresh per test.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'

interface SentEvent {
  event: string
  properties: Record<string, unknown>
}

interface SentException {
  type?: string
  value?: string
  mechanism?: { type?: string; handled?: boolean }
  stacktrace?: { frames?: Array<{ lineno?: unknown; colno?: unknown }> }
}

const sent = vi.hoisted(() => [] as SentEvent[])
const sdk = vi.hoisted(() => ({ instance: undefined as unknown }))

// A variable, so the type checker does not try to resolve the untyped bundle.
const AUTOCAPTURE_EXTENSION = 'posthog-js/dist/exception-autocapture.js'

vi.mock('posthog-js', async (importOriginal) => {
  if (!sdk.instance) {
    const { PostHog } = await importOriginal<typeof import('posthog-js')>()
    await import(/* @vite-ignore */ AUTOCAPTURE_EXTENSION)
    const real = new PostHog()
    const init = real.init.bind(real)
    const record = (event: unknown) => {
      if (event) sent.push(event as SentEvent)
      return null
    }
    real.init = ((token: string, config: { before_send?: unknown; error_tracking?: object }) =>
      (real as unknown as { __loaded?: boolean }).__loaded
        ? real
        : init(token, {
            ...config,
            // Test transport only: no remote config or extension scripts in
            // node, and room for every exception this file raises.
            advanced_disable_flags: true,
            disable_external_dependency_loading: true,
            error_tracking: { ...config.error_tracking, __exceptionRateLimiterBucketSize: 100 },
            before_send: [config.before_send, record].flat().filter(Boolean),
          } as never)) as typeof real.init
    sdk.instance = real
  }
  return { default: sdk.instance }
})

const PAGE = 'https://app.example.test/bookkeeping'

type FakeWindow = EventTarget & {
  onerror?: (...args: unknown[]) => unknown
  onunhandledrejection?: (event: unknown) => unknown
}

/** Enough of a browser for posthog-js to start: a window that can dispatch events. */
function fakeBrowser(): FakeWindow {
  const noop = () => {}
  const events = new EventTarget()
  const location = {
    href: PAGE,
    host: 'app.example.test',
    hostname: 'app.example.test',
    pathname: '/bookkeeping',
    protocol: 'https:',
    search: '',
    hash: '',
    origin: 'https://app.example.test',
  }
  const document = {
    URL: PAGE,
    readyState: 'complete',
    location,
    referrer: '',
    title: '',
    cookie: '',
    addEventListener: noop,
    removeEventListener: noop,
    createElement: () => ({ setAttribute: noop, style: {} }),
    getElementsByTagName: () => [],
    querySelector: () => null,
    querySelectorAll: () => [],
    body: {},
    documentElement: {},
    head: { appendChild: noop },
  }
  const navigator = { userAgent: 'vitest', language: 'sv', languages: ['sv'], doNotTrack: null, sendBeacon: () => true }
  const window = {
    location,
    document,
    navigator,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    screen: { width: 400, height: 800 },
    innerWidth: 400,
    innerHeight: 800,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => ({ status: 200, json: async () => ({}), text: async () => '' }),
    performance: globalThis.performance,
    crypto: globalThis.crypto,
    console,
  }
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', document)
  vi.stubGlobal('navigator', navigator)
  vi.stubGlobal('location', location)
  return window as unknown as FakeWindow
}

/** A fresh module graph per test: client.ts keeps the "started" flag per tab. */
async function load() {
  vi.resetModules()
  const earlyErrors = await import('../early-errors')
  const client = await import('../client')
  return { ...earlyErrors, ...client }
}

async function start(client: Awaited<ReturnType<typeof load>>) {
  client.initAnalytics()
  const posthog = await client.analyticsReady()
  if (!posthog) throw new Error('PostHog did not start')
  return posthog
}

function exceptionEvents(): SentEvent[] {
  return sent.filter((e) => e.event === '$exception')
}

function exceptions(): SentException[] {
  return exceptionEvents().flatMap((e) => e.properties.$exception_list as SentException[])
}

/** What Error Tracking needs to group and locate an error, which redaction must leave. */
function expectStillLocatable(exception: SentException) {
  expect(exception.type).toBe('Error')
  expect(exception.mechanism).toBeDefined()
  const frames = exception.stacktrace?.frames ?? []
  expect(frames.length).toBeGreaterThan(0)
  expect(typeof frames[0].lineno).toBe('number')
  expect(typeof frames[0].colno).toBe('number')
}

describe('exception events leave the browser redacted', () => {
  let window: FakeWindow

  beforeAll(() => {
    window = fakeBrowser()
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    sent.length = 0
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('an error raised before analytics started (early-errors.ts)', async () => {
    const client = await load()
    client.bufferEarlyErrors(window as never)
    const raised = Object.assign(new Event('error'), { error: new Error('no company for 800101-1234') })
    window.dispatchEvent(raised)

    await start(client)

    await vi.waitFor(() => expect(exceptions()).toHaveLength(1))
    expect(exceptions()[0].value).not.toContain('800101-1234')
    expectStillLocatable(exceptions()[0])
    expect(exceptionEvents()[0].properties.before_analytics_start).toBe(true)
  })

  it('an uncaught error the SDK catches itself (window.onerror)', async () => {
    const client = await load()
    await start(client)
    expect(typeof window.onerror).toBe('function')

    const thrown = new Error('no company for 800101-1234')
    window.onerror!(`Uncaught ${thrown}`, `${PAGE}.js`, 1, 1, thrown)

    await vi.waitFor(() => expect(exceptions()).toHaveLength(1))
    expect(exceptions()[0].value).not.toContain('800101-1234')
    expectStillLocatable(exceptions()[0])
  })

  it('an unhandled rejection the SDK catches itself (window.onunhandledrejection)', async () => {
    const client = await load()
    await start(client)
    expect(typeof window.onunhandledrejection).toBe('function')

    window.onunhandledrejection!({ reason: new Error('Invite to person@example.se failed') })

    await vi.waitFor(() => expect(exceptions()).toHaveLength(1))
    expect(exceptions()[0].value).toBe('Invite to [REDACTED_EMAIL] failed')
  })

  it('an error captured through the SDK keeps the rest of its message and says what was removed', async () => {
    const client = await load()
    const posthog = await start(client)

    posthog.captureException(new Error('Invite to person@example.se failed'))

    await vi.waitFor(() => expect(exceptions()).toHaveLength(1))
    expect(exceptions()[0].value).toBe('Invite to [REDACTED_EMAIL] failed')
    expectStillLocatable(exceptions()[0])
  })

  it('an error an error boundary caught (captureBoundaryError), with its frames', async () => {
    const client = await load()
    await start(client)

    client.captureBoundaryError(new Error('no company for 800101-1234'), 'dashboard')

    await vi.waitFor(() => expect(exceptions()).toHaveLength(1))
    expect(exceptions()[0].value).not.toContain('800101-1234')
    expectStillLocatable(exceptions()[0])
    expect(exceptionEvents()[0].properties.error_boundary).toBe('dashboard')
  })

  it('the steps the SDK recorded before an error', async () => {
    const client = await load()
    const posthog = await start(client)

    posthog.addExceptionStep('Opened the customer person@example.se', { customer: 'other@example.se' })
    posthog.captureException(new Error('boom'))

    await vi.waitFor(() => expect(exceptionEvents()).toHaveLength(1))
    const steps = JSON.stringify(exceptionEvents()[0].properties.$exception_steps)
    expect(steps).toContain('[REDACTED_EMAIL]')
    expect(steps).not.toContain('@example.se')
  })

  it('leaves every other event as it is', async () => {
    const client = await load()
    const posthog = await start(client)

    posthog.capture('report_opened', { report: 'balance_sheet' })

    await vi.waitFor(() => expect(sent.some((e) => e.event === 'report_opened')).toBe(true))
    expect(sent.find((e) => e.event === 'report_opened')!.properties.report).toBe('balance_sheet')
  })
})

describe('redactExceptionEvent', () => {
  it('drops an exception it cannot redact instead of sending it raw', async () => {
    const { redactExceptionEvent } = await load()
    const unreadable = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        throw new Error('revoked')
      },
    })

    const result = redactExceptionEvent({
      uuid: 'u1',
      event: '$exception',
      properties: { $exception_list: [unreadable] },
    } as never)

    expect(result).toBeNull()
  })

  it('passes a missing event through', async () => {
    const { redactExceptionEvent } = await load()
    expect(redactExceptionEvent(null)).toBeNull()
  })
})
