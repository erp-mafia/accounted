import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'

const posthogMock = vi.hoisted(() => ({ init: vi.fn(), captureException: vi.fn() }))
vi.mock('posthog-js', () => ({ default: posthogMock }))

/** A window stand-in: an EventTarget with a location, enough for the buffer. */
function fakeWindow(pathname: string) {
  return Object.assign(new EventTarget(), { location: { pathname } })
}

/** What window.reportError dispatches; Node has no ErrorEvent, so a plain Event carries the fields. */
function errorEvent(error: unknown, message = 'Script error.'): Event {
  return Object.assign(new Event('error'), { error, message })
}

function rejectionEvent(reason: unknown): Event {
  return Object.assign(new Event('unhandledrejection'), { reason })
}

// The buffer is module state, as in the browser (one per page load): every
// test starts from a fresh module.
async function load() {
  vi.resetModules()
  return import('../early-errors')
}

describe('early error buffer', () => {
  it('hands the errors raised before the start to the page PostHog starts on', async () => {
    const { bufferEarlyErrors, drainEarlyErrors } = await load()
    const win = fakeWindow('/')
    bufferEarlyErrors(win as unknown as Window)
    // React #418, as Next.js reports it during hydration.
    const hydration = new Error('Minified React error #418')
    win.dispatchEvent(errorEvent(hydration))
    win.dispatchEvent(rejectionEvent('chunk failed'))

    expect(drainEarlyErrors('/')).toEqual([hydration, 'chunk failed'])
  })

  it('falls back to the message when the event carries no error object', async () => {
    const { bufferEarlyErrors, drainEarlyErrors } = await load()
    const win = fakeWindow('/')
    bufferEarlyErrors(win as unknown as Window)
    win.dispatchEvent(errorEvent(undefined, 'Script error.'))
    expect(drainEarlyErrors('/')).toEqual(['Script error.'])
  })

  it('drops errors raised on an earlier page of the same tab', async () => {
    const { bufferEarlyErrors, drainEarlyErrors } = await load()
    const win = fakeWindow('/login')
    bufferEarlyErrors(win as unknown as Window)
    win.dispatchEvent(errorEvent(new Error('on the login page')))
    win.location.pathname = '/'
    const onHem = new Error('on Hem')
    win.dispatchEvent(errorEvent(onHem))

    expect(drainEarlyErrors('/')).toEqual([onHem])
  })

  it('holds at most MAX_EARLY_ERRORS', async () => {
    const { bufferEarlyErrors, drainEarlyErrors, MAX_EARLY_ERRORS } = await load()
    const win = fakeWindow('/')
    bufferEarlyErrors(win as unknown as Window)
    for (let i = 0; i < MAX_EARLY_ERRORS + 5; i++) win.dispatchEvent(errorEvent(new Error(`e${i}`)))
    expect(drainEarlyErrors('/')).toHaveLength(MAX_EARLY_ERRORS)
  })

  it('stops listening once drained, so PostHog alone reports what follows', async () => {
    const { bufferEarlyErrors, drainEarlyErrors } = await load()
    const win = fakeWindow('/')
    bufferEarlyErrors(win as unknown as Window)
    expect(drainEarlyErrors('/')).toEqual([])
    win.dispatchEvent(errorEvent(new Error('after the start')))
    expect(drainEarlyErrors('/')).toEqual([])
  })

  it('holds nothing when never started (analytics off for the build)', async () => {
    const { drainEarlyErrors } = await load()
    expect(drainEarlyErrors('/')).toEqual([])
  })
})

describe('initAnalytics sends the held errors on', () => {
  beforeEach(() => {
    posthogMock.init.mockReset()
    posthogMock.captureException.mockReset()
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('captures each error the page raised before PostHog started, after init', async () => {
    const win = fakeWindow('/')
    vi.stubGlobal('window', win)
    vi.resetModules()
    const { bufferEarlyErrors } = await import('../early-errors')
    const { initAnalytics, analyticsReady } = await import('../client')
    bufferEarlyErrors(win as unknown as Window)
    const hydration = new Error('Minified React error #418')
    win.dispatchEvent(errorEvent(hydration))

    expect(initAnalytics()).toBe(true)
    // The SDK loads after the page (client.ts): init and the held errors follow it.
    await analyticsReady()
    expect(posthogMock.init).toHaveBeenCalledTimes(1)
    expect(posthogMock.captureException).toHaveBeenCalledTimes(1)
    expect(posthogMock.captureException).toHaveBeenCalledWith(hydration, { before_analytics_start: true })
    expect(posthogMock.init.mock.invocationCallOrder[0]).toBeLessThan(
      posthogMock.captureException.mock.invocationCallOrder[0],
    )

    // A second call (another layout effect run) starts nothing and resends nothing.
    expect(initAnalytics()).toBe(true)
    await analyticsReady()
    expect(posthogMock.init).toHaveBeenCalledTimes(1)
    expect(posthogMock.captureException).toHaveBeenCalledTimes(1)
  })

  it('sends nothing when analytics is off for the deployment', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', '')
    const win = fakeWindow('/')
    vi.stubGlobal('window', win)
    vi.resetModules()
    const { bufferEarlyErrors } = await import('../early-errors')
    const { initAnalytics } = await import('../client')
    bufferEarlyErrors(win as unknown as Window)
    win.dispatchEvent(errorEvent(new Error('Minified React error #418')))

    expect(initAnalytics()).toBe(false)
    expect(posthogMock.init).not.toHaveBeenCalled()
    expect(posthogMock.captureException).not.toHaveBeenCalled()
  })
})
