import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ph = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
}))

vi.mock('posthog-js', () => ({ default: ph }))

/** A fresh module graph per test: client.ts keeps the "started" flag per tab. */
async function load() {
  vi.resetModules()
  return import('../client')
}

/** Let a capture queued behind analyticsReady() run. */
async function settle(client: Awaited<ReturnType<typeof load>>) {
  await client.analyticsReady()
  await Promise.resolve()
}

describe('captureBoundaryError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { location: { pathname: '/' } })
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('sends an error a boundary caught to PostHog, named by the boundary', async () => {
    const client = await load()
    client.initAnalytics()
    await client.analyticsReady()

    client.captureBoundaryError(new TypeError("Cannot read properties of undefined (reading 'lines')"), 'dashboard')
    await settle(client)

    expect(ph.captureException).toHaveBeenCalledTimes(1)
    const [sent, properties] = ph.captureException.mock.calls[0]
    expect(sent).toBeInstanceOf(Error)
    expect(sent.name).toBe('TypeError')
    expect(sent.message).toBe("Cannot read properties of undefined (reading 'lines')")
    expect(properties).toEqual({ error_boundary: 'dashboard', auto_reload: false })
  })

  it('says when the boundary reloaded at once, so the person never saw the fallback', async () => {
    const client = await load()
    client.initAnalytics()
    await client.analyticsReady()

    client.captureBoundaryError(new Error('ChunkLoadError'), 'app', true)
    await settle(client)

    expect(ph.captureException.mock.calls[0][1]).toEqual({ error_boundary: 'app', auto_reload: true })
  })

  it('redacts the error before it leaves the browser', async () => {
    const client = await load()
    client.initAnalytics()
    await client.analyticsReady()

    client.captureBoundaryError(new Error('no company for 800101-1234'), 'app')
    await settle(client)

    const [sent] = ph.captureException.mock.calls[0]
    expect(sent.message).not.toContain('800101-1234')
    expect(String(sent.stack)).not.toContain('800101-1234')
  })

  it('leaves out an error with a digest: the server captured it in onRequestError', async () => {
    const client = await load()
    client.initAnalytics()
    await client.analyticsReady()

    const fromServer = Object.assign(new Error('An error occurred in the Server Components render.'), { digest: '2786412345' })
    client.captureBoundaryError(fromServer, 'dashboard')
    await settle(client)

    expect(ph.captureException).not.toHaveBeenCalled()
  })

  it('sends nothing and starts nothing when analytics does not run', async () => {
    const client = await load()

    client.captureBoundaryError(new Error('boom'), 'global')
    await settle(client)

    expect(ph.init).not.toHaveBeenCalled()
    expect(ph.captureException).not.toHaveBeenCalled()
  })

  it('never throws, and sends nothing, for a value whose digest cannot be read', async () => {
    const client = await load()
    client.initAnalytics()
    await client.analyticsReady()

    const unreadable = Object.defineProperty(new Error('boom'), 'digest', {
      get() {
        throw new Error('revoked')
      },
    })
    expect(() => client.captureBoundaryError(unreadable, 'dashboard')).not.toThrow()
    await settle(client)

    expect(ph.captureException).not.toHaveBeenCalled()
  })

  it('never throws, and sends nothing, for a value whose message cannot be read', async () => {
    const client = await load()
    client.initAnalytics()
    await client.analyticsReady()

    const unreadable = Object.defineProperty(new Error('boom'), 'message', {
      get() {
        throw new Error('revoked')
      },
    })
    expect(() => client.captureBoundaryError(unreadable, 'app')).not.toThrow()
    await settle(client)

    expect(ph.captureException).not.toHaveBeenCalled()
  })

  // The SDK throws inside the queued capture, so a missing guard shows up as
  // an unhandled rejection, which fails the run.
  it('never throws into the boundary when the SDK throws', async () => {
    ph.captureException.mockImplementationOnce(() => {
      throw new Error('sdk down')
    })
    const client = await load()
    client.initAnalytics()
    await client.analyticsReady()

    expect(() => client.captureBoundaryError(new Error('boom'), 'global')).not.toThrow()
    await settle(client)

    expect(ph.captureException).toHaveBeenCalledTimes(1)
  })
})
