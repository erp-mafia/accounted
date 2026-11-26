import { afterEach, describe, expect, it, vi } from 'vitest'
import { SOURCES_FLOW_EXTENSIONS, isOnboardingSourcesEnabled, sourcesFlowAvailable } from '../sources-rollout'

afterEach(() => vi.unstubAllEnvs())

describe('isOnboardingSourcesEnabled', () => {
  it('is off for everyone when the list is unset or empty', () => {
    vi.stubEnv('ONBOARDING_SOURCES_USER_IDS', '')
    expect(isOnboardingSourcesEnabled('user-1')).toBe(false)
    vi.stubEnv('ONBOARDING_SOURCES_USER_IDS', '   ')
    expect(isOnboardingSourcesEnabled('user-1')).toBe(false)
    vi.unstubAllEnvs()
    delete process.env.ONBOARDING_SOURCES_USER_IDS
    expect(isOnboardingSourcesEnabled('user-1')).toBe(false)
  })

  it('is on only for the listed users', () => {
    vi.stubEnv('ONBOARDING_SOURCES_USER_IDS', 'user-1,user-2')
    expect(isOnboardingSourcesEnabled('user-1')).toBe(true)
    expect(isOnboardingSourcesEnabled('user-2')).toBe(true)
    expect(isOnboardingSourcesEnabled('user-3')).toBe(false)
  })

  it('is on for everyone with *', () => {
    vi.stubEnv('ONBOARDING_SOURCES_USER_IDS', '*')
    expect(isOnboardingSourcesEnabled('anyone')).toBe(true)
  })

  it('ignores whitespace around ids and empty entries', () => {
    vi.stubEnv('ONBOARDING_SOURCES_USER_IDS', ' user-1 , ,user-2 ')
    expect(isOnboardingSourcesEnabled('user-1')).toBe(true)
    expect(isOnboardingSourcesEnabled('user-2')).toBe(true)
    expect(isOnboardingSourcesEnabled('')).toBe(false)
  })

  it('is off without a user, even for *', () => {
    vi.stubEnv('ONBOARDING_SOURCES_USER_IDS', '*')
    expect(isOnboardingSourcesEnabled(null)).toBe(false)
    expect(isOnboardingSourcesEnabled(undefined)).toBe(false)
  })
})

describe('sourcesFlowAvailable', () => {
  it('needs every extension its own stops connect through', () => {
    expect(sourcesFlowAvailable(new Set(SOURCES_FLOW_EXTENSIONS))).toBe(true)
    expect(sourcesFlowAvailable(new Set([...SOURCES_FLOW_EXTENSIONS, 'enable-banking']))).toBe(true)
    expect(sourcesFlowAvailable(new Set(['mcp-server']))).toBe(false)
    expect(sourcesFlowAvailable(new Set(['invoice-inbox']))).toBe(false)
    expect(sourcesFlowAvailable(new Set())).toBe(false)
  })
})
