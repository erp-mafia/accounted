import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const registerObservabilitySink = vi.fn()
const postHogSink = { name: 'posthog' }

vi.mock('@/lib/observability', () => ({ registerObservabilitySink }))
vi.mock('@/lib/analytics/posthog-observability', () => ({ postHogSink }))

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
    expect(registerObservabilitySink).toHaveBeenCalledWith(postHogSink)
  })

  it('registers once however often it is called (root layout and ensureInitialized both call it)', async () => {
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
