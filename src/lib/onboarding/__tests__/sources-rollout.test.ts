import { afterEach, describe, expect, it, vi } from 'vitest'
import { isOnboardingSourcesEnabled } from '../sources-rollout'

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
