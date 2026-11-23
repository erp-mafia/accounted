import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ph = vi.hoisted(() => ({
  init: vi.fn(),
  identify: vi.fn(),
  setIdentity: vi.fn(),
  group: vi.fn(),
  captureException: vi.fn(),
  stopSessionRecording: vi.fn(),
  reset: vi.fn(),
}))

vi.mock('posthog-js', () => ({ default: ph }))

// How often the SDK module was fetched, and whether the fetch fails (an ad
// blocker, a dropped connection). Registered again before each test: Vitest
// keeps a mocked module across vi.resetModules(), so each test needs its own.
const sdkFetch = { count: 0, fail: false }
function mockSdkFetch() {
  sdkFetch.count = 0
  sdkFetch.fail = false
  vi.doMock('posthog-js', () => {
    sdkFetch.count++
    if (sdkFetch.fail) throw new Error('blocked by the browser')
    return { default: ph }
  })
}

const USER = { userId: 'user-1', email: 'a@example.test', fullName: 'A', role: 'owner' as const }
const COMPANY = { id: 'company-1', name: 'Bolaget AB', capabilities: ['salary', 'invoicing'] }

/** A fresh module graph per test: client.ts keeps the "started" flag per tab. */
async function load() {
  vi.resetModules()
  const identify = await import('../identify')
  const client = await import('../client')
  return { ...identify, ...client }
}

describe('identifySignedInPerson', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSdkFetch()
    vi.stubGlobal('window', { location: { pathname: '/' } })
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('starts PostHog, then verifies, identifies and groups, in that order', async () => {
    const { identifySignedInPerson, isAnalyticsActive, analyticsReady } = await load()

    expect(identifySignedInPerson({ analyticsOn: true, user: USER, identityHash: 'hmac', company: COMPANY })).toBe(true)
    // Analytics runs from the call; the SDK loads after the page (client.ts).
    expect(isAnalyticsActive()).toBe(true)
    await analyticsReady()

    expect(ph.init).toHaveBeenCalledTimes(1)
    expect(ph.setIdentity).toHaveBeenCalledWith('user-1', 'hmac')
    expect(ph.identify).toHaveBeenCalledWith('user-1', { email: 'a@example.test', name: 'A', role: 'owner' })
    expect(ph.group).toHaveBeenCalledWith('company', 'company-1', expect.objectContaining({ name: 'Bolaget AB', capabilities: ['invoicing', 'salary'] }))
    const order = [ph.init, ph.setIdentity, ph.identify, ph.group].map((fn) => fn.mock.invocationCallOrder[0])
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(isAnalyticsActive()).toBe(true)
  })

  it('records what fits the free plan: clicks in the menu, top bar and on primary actions, no page leaves, 70% of replays', async () => {
    const { identifySignedInPerson, analyticsReady } = await load()
    identifySignedInPerson({ analyticsOn: true, user: USER, identityHash: null })
    await analyticsReady()

    const options = ph.init.mock.calls[0][1]
    expect(options.autocapture).toEqual({
      dom_event_allowlist: ['click'],
      element_allowlist: ['a', 'button'],
      css_selector_allowlist: ['nav', 'aside', '.page-header', '[data-ph-capture]'],
    })
    expect(options.capture_pageleave).toBe(false)
    expect(options.session_recording).toMatchObject({ sampleRate: 0.7, maskAllInputs: true })
    // The privacy choices stay as they were.
    expect(options.persistence).toBe('memory')
    expect(options.api_host).toBe('/rl')
  })

  it('does nothing at all when the person switched analytics off', async () => {
    const { identifySignedInPerson, isAnalyticsActive } = await load()

    expect(identifySignedInPerson({ analyticsOn: false, user: USER, identityHash: 'hmac', company: COMPANY })).toBe(false)

    expect(ph.init).not.toHaveBeenCalled()
    expect(ph.setIdentity).not.toHaveBeenCalled()
    expect(ph.identify).not.toHaveBeenCalled()
    expect(ph.group).not.toHaveBeenCalled()
    expect(isAnalyticsActive()).toBe(false)
  })

  it('never identifies on a deployment without PostHog (self-hosted, no token)', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', '')
    const { identifySignedInPerson } = await load()

    expect(identifySignedInPerson({ analyticsOn: true, user: USER, company: COMPANY })).toBe(false)

    expect(ph.init).not.toHaveBeenCalled()
    expect(ph.identify).not.toHaveBeenCalled()
  })

  it('starts PostHog once per tab but identifies on every call', async () => {
    const { identifySignedInPerson, analyticsReady } = await load()

    // The onboarding layout (no company), then the dashboard after a client-side navigation.
    identifySignedInPerson({ analyticsOn: true, user: USER })
    identifySignedInPerson({ analyticsOn: true, user: USER, company: COMPANY })
    await analyticsReady()

    expect(ph.init).toHaveBeenCalledTimes(1)
    expect(ph.identify).toHaveBeenCalledTimes(2)
    expect(ph.group).toHaveBeenCalledTimes(1)
  })

  it('identifies without a company and without the verified-identity hash', async () => {
    const { identifySignedInPerson, analyticsReady } = await load()

    expect(identifySignedInPerson({ analyticsOn: true, user: { userId: 'user-2' }, identityHash: null })).toBe(true)
    await analyticsReady()

    expect(ph.setIdentity).not.toHaveBeenCalled()
    expect(ph.identify).toHaveBeenCalledWith('user-2', {})
    expect(ph.group).not.toHaveBeenCalled()
  })

  it('loads the SDK only once analytics starts, never for a person who switched it off', async () => {
    const off = await load()
    expect(off.identifySignedInPerson({ analyticsOn: false, user: USER })).toBe(false)
    expect(await off.analyticsReady()).toBeNull()
    expect(off.loadedAnalytics()).toBeNull()
    expect(sdkFetch.count).toBe(0)
    expect(ph.init).not.toHaveBeenCalled()

    const on = await load()
    on.identifySignedInPerson({ analyticsOn: true, user: USER })
    await on.analyticsReady()
    expect(sdkFetch.count).toBe(1)
  })

  it('stays silent for the page load when the SDK cannot be fetched', async () => {
    sdkFetch.fail = true
    const { identifySignedInPerson, analyticsReady, loadedAnalytics, analyticsLoadFailed, captureAnalyticsEvent } = await load()

    // Consent was given, so analytics counts as started; the fetch then fails.
    expect(identifySignedInPerson({ analyticsOn: true, user: USER })).toBe(true)
    expect(analyticsLoadFailed()).toBe(false)
    expect(await analyticsReady()).toBeNull()

    expect(analyticsLoadFailed()).toBe(true)
    expect(loadedAnalytics()).toBeNull()
    expect(() => captureAnalyticsEvent('setup_step_viewed')).not.toThrow()
    await analyticsReady()
    expect(ph.identify).not.toHaveBeenCalled()
  })

  it('treats an SDK that throws in init as one that did not load', async () => {
    ph.init.mockImplementationOnce(() => {
      throw new Error('bad config')
    })
    const { identifySignedInPerson, analyticsReady, loadedAnalytics, analyticsLoadFailed } = await load()

    identifySignedInPerson({ analyticsOn: true, user: USER })

    expect(await analyticsReady()).toBeNull()
    expect(analyticsLoadFailed()).toBe(true)
    expect(loadedAnalytics()).toBeNull()
    expect(ph.identify).not.toHaveBeenCalled()
  })

  it('a logout while the SDK loads resets after the queued identify, not before', async () => {
    const { identifySignedInPerson, analyticsReady } = await load()
    const { resetAnalyticsIdentity } = await import('../reset')

    identifySignedInPerson({ analyticsOn: true, user: USER })
    resetAnalyticsIdentity()
    await analyticsReady()

    expect(ph.identify).toHaveBeenCalledTimes(1)
    expect(ph.reset).toHaveBeenCalledTimes(1)
    expect(ph.identify.mock.invocationCallOrder[0]).toBeLessThan(ph.reset.mock.invocationCallOrder[0])
  })

  it('consent withdrawn after the SDK loaded stops the recording and drops the identity', async () => {
    const { identifySignedInPerson, stopAnalytics, analyticsReady } = await load()

    identifySignedInPerson({ analyticsOn: true, user: USER })
    await analyticsReady()
    stopAnalytics()

    expect(ph.stopSessionRecording).toHaveBeenCalledTimes(1)
    expect(ph.reset).toHaveBeenCalledTimes(1)
  })

  it('holds an event captured while the SDK loads and sends it after init', async () => {
    const { identifySignedInPerson, captureAnalyticsEvent, analyticsReady, loadedAnalytics } = await load()
    const capture = vi.fn()
    Object.assign(ph, { capture })

    identifySignedInPerson({ analyticsOn: true, user: USER })
    // Before the SDK has loaded: nothing to read synchronously, nothing lost.
    expect(loadedAnalytics()).toBeNull()
    captureAnalyticsEvent('setup_step_viewed', { step: 'bank' })
    await analyticsReady()

    expect(loadedAnalytics()).toBe(ph)
    expect(capture).toHaveBeenCalledWith('setup_step_viewed', { step: 'bank' })
    expect(ph.init.mock.invocationCallOrder[0]).toBeLessThan(capture.mock.invocationCallOrder[0])
  })

  it('never starts an SDK still loading when consent is withdrawn', async () => {
    const { identifySignedInPerson, stopAnalytics, analyticsReady } = await load()

    identifySignedInPerson({ analyticsOn: true, user: USER })
    stopAnalytics()

    expect(await analyticsReady()).toBeNull()
    expect(ph.init).not.toHaveBeenCalled()
    expect(ph.identify).not.toHaveBeenCalled()
  })
})
