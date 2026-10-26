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
    vi.stubGlobal('window', { location: { pathname: '/' } })
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('starts PostHog, then verifies, identifies and groups, in that order', async () => {
    const { identifySignedInPerson, isAnalyticsActive } = await load()

    expect(identifySignedInPerson({ analyticsOn: true, user: USER, identityHash: 'hmac', company: COMPANY })).toBe(true)

    expect(ph.init).toHaveBeenCalledTimes(1)
    expect(ph.setIdentity).toHaveBeenCalledWith('user-1', 'hmac')
    expect(ph.identify).toHaveBeenCalledWith('user-1', { email: 'a@example.test', name: 'A', role: 'owner' })
    expect(ph.group).toHaveBeenCalledWith('company', 'company-1', expect.objectContaining({ name: 'Bolaget AB', capabilities: ['invoicing', 'salary'] }))
    const order = [ph.init, ph.setIdentity, ph.identify, ph.group].map((fn) => fn.mock.invocationCallOrder[0])
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(isAnalyticsActive()).toBe(true)
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
    const { identifySignedInPerson } = await load()

    // The onboarding layout (no company), then the dashboard after a client-side navigation.
    identifySignedInPerson({ analyticsOn: true, user: USER })
    identifySignedInPerson({ analyticsOn: true, user: USER, company: COMPANY })

    expect(ph.init).toHaveBeenCalledTimes(1)
    expect(ph.identify).toHaveBeenCalledTimes(2)
    expect(ph.group).toHaveBeenCalledTimes(1)
  })

  it('identifies without a company and without the verified-identity hash', async () => {
    const { identifySignedInPerson } = await load()

    expect(identifySignedInPerson({ analyticsOn: true, user: { userId: 'user-2' }, identityHash: null })).toBe(true)

    expect(ph.setIdentity).not.toHaveBeenCalled()
    expect(ph.identify).toHaveBeenCalledWith('user-2', {})
    expect(ph.group).not.toHaveBeenCalled()
  })
})
