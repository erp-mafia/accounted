import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const registerObservabilitySink = vi.fn()
const postHogSink = vi.hoisted(() => ({
  name: 'posthog',
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn(async () => true),
}))
const adapterLoads = vi.hoisted(() => ({ count: 0 }))

vi.mock('@/lib/observability', () => ({ registerObservabilitySink }))
vi.mock('@/lib/analytics/posthog-observability', () => {
  adapterLoads.count++
  return { postHogSink }
})

// A fresh module per test: the once-per-process flag lives in module state.
async function loadEnsureObservability() {
  vi.resetModules()
  return (await import('../ensure-observability')).ensureObservability
}

describe('ensureObservability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('registers the PostHog sink when analytics is enabled', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
    const ensureObservability = await loadEnsureObservability()

    ensureObservability()

    expect(registerObservabilitySink).toHaveBeenCalledTimes(1)
    expect(registerObservabilitySink).toHaveBeenCalledWith(expect.objectContaining({ name: 'posthog' }))
  })

  it('registers once however often it is called (server-baseline and ensureInitialized both call it)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
    const ensureObservability = await loadEnsureObservability()

    ensureObservability()
    ensureObservability()
    ensureObservability()

    expect(registerObservabilitySink).toHaveBeenCalledTimes(1)
  })

  it('leaves the no-op sink in place without a PostHog token', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', '')
    const ensureObservability = await loadEnsureObservability()

    ensureObservability()

    expect(registerObservabilitySink).not.toHaveBeenCalled()
  })

  it('never registers on a self-hosted instance, even with a token', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
    const ensureObservability = await loadEnsureObservability()

    ensureObservability()

    expect(registerObservabilitySink).not.toHaveBeenCalled()
  })
})

describe('the lazily loaded PostHog sink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    adapterLoads.count = 0
  })

  async function lazySink() {
    vi.resetModules()
    return (await import('../ensure-observability')).createLazyPostHogSink()
  }

  it('loads the adapter only when the first event arrives', async () => {
    const sink = await lazySink()
    expect(await sink.flush()).toBe(true)
    expect(adapterLoads.count).toBe(0)

    sink.captureException({ message: 'boom' }, { module: 'test' })
    await vi.waitFor(() => expect(postHogSink.captureException).toHaveBeenCalledWith({ message: 'boom' }, { module: 'test' }))
    expect(adapterLoads.count).toBe(1)
  })

  it('flush ships what was captured before it, then drains the adapter', async () => {
    const sink = await lazySink()
    sink.captureException({ message: 'first' }, {})
    sink.captureMessage('second', 'error', { alert: true })

    expect(await sink.flush(500)).toBe(true)

    expect(postHogSink.captureException).toHaveBeenCalledWith({ message: 'first' }, {})
    expect(postHogSink.captureMessage).toHaveBeenCalledWith('second', 'error', { alert: true })
    expect(postHogSink.flush).toHaveBeenCalledWith(500)
    const captured = postHogSink.captureMessage.mock.invocationCallOrder[0]
    expect(captured).toBeLessThan(postHogSink.flush.mock.invocationCallOrder[0])
  })
})
