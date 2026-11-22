/**
 * What leaves the browser when an error is captured, judged on the real
 * posthog-js rather than a mock: the SDK turns the thrown value into its own
 * $exception event, and that event is what must arrive redacted.
 *
 * The real SDK starts in node with a minimal window. posthog.init is wrapped
 * only to put a recorder after the hooks initAnalytics() configures: the
 * recorder keeps what would be sent and drops it, so nothing goes anywhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

interface SentEvent {
  event: string
  properties: Record<string, unknown>
}

const sent = vi.hoisted(() => [] as SentEvent[])

vi.mock('posthog-js', async (importOriginal) => {
  const real = (await importOriginal<typeof import('posthog-js')>()).default
  const init = real.init.bind(real)
  const record = (event: unknown) => {
    if (event) sent.push(event as SentEvent)
    return null
  }
  real.init = ((token: string, config: { before_send?: unknown }) =>
    init(token, {
      ...config,
      // Test transport only: no remote config or extension scripts in node.
      advanced_disable_flags: true,
      disable_external_dependency_loading: true,
      before_send: [config.before_send, record].flat().filter(Boolean),
    } as never)) as typeof real.init
  return { default: real }
})

const PAGE = 'https://app.example.test/bookkeeping'

/** Enough of a browser for posthog-js to start: a window that can dispatch events. */
function fakeBrowser(): EventTarget {
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
  return window as unknown as EventTarget
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

function exceptionValues(): string[] {
  return sent
    .filter((e) => e.event === '$exception')
    .flatMap((e) => (e.properties.$exception_list as Array<{ value?: string }>).map((x) => String(x.value)))
}

describe('exception events leave the browser redacted', () => {
  beforeEach(() => {
    sent.length = 0
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('an error raised before analytics started (early-errors.ts)', async () => {
    const window = fakeBrowser()
    const client = await load()
    client.bufferEarlyErrors(window as never)
    const raised = Object.assign(new Event('error'), { error: new Error('no company for 800101-1234') })
    window.dispatchEvent(raised)

    await start(client)

    await vi.waitFor(() => expect(exceptionValues()).toHaveLength(1))
    expect(exceptionValues()[0]).not.toContain('800101-1234')
    const [held] = sent.filter((e) => e.event === '$exception')
    expect(held.properties.before_analytics_start).toBe(true)
  })

  it('an error captured through the SDK keeps the rest of its message and says what was removed', async () => {
    fakeBrowser()
    const client = await load()
    const posthog = await start(client)

    posthog.captureException(new Error('Invite to person@example.se failed'))

    await vi.waitFor(() => expect(exceptionValues()).toHaveLength(1))
    expect(exceptionValues()[0]).toBe('Invite to [REDACTED_EMAIL] failed')
  })

  it('an error an error boundary caught (captureBoundaryError)', async () => {
    fakeBrowser()
    const client = await load()
    await start(client)

    client.captureBoundaryError(new Error('Payout to SE45 5000 0000 0583 9825 7466 refused'), 'dashboard')

    await vi.waitFor(() => expect(exceptionValues()).toHaveLength(1))
    expect(exceptionValues()[0]).toBe('Payout to [REDACTED_IBAN] refused')
  })

  it('leaves every other event as it is', async () => {
    fakeBrowser()
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
