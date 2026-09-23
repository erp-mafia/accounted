import { describe, it, expect, vi, afterEach } from 'vitest'
import { isAnalyticsEnabled, warnIfAnalyticsMisconfigured, POSTHOG_TOKEN_VAR } from '../enabled'

describe('analytics gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  describe('isAnalyticsEnabled', () => {
    it('returns false when NEXT_PUBLIC_SELF_HOSTED is true, even with a token', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
      expect(isAnalyticsEnabled()).toBe(false)
    })

    it('returns true when a token is set and not self-hosted', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
      expect(isAnalyticsEnabled()).toBe(true)
    })

    it('returns false when the token is unset', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', '')
      expect(isAnalyticsEnabled()).toBe(false)
    })
  })

  describe('warnIfAnalyticsMisconfigured', () => {
    it('returns true and stays quiet when configured', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
      expect(warnIfAnalyticsMisconfigured()).toBe(true)
      expect(warn).not.toHaveBeenCalled()
    })

    it('warns in development when the token is missing', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', '')
      vi.stubEnv('NODE_ENV', 'development')
      expect(warnIfAnalyticsMisconfigured()).toBe(false)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(POSTHOG_TOKEN_VAR))
    })

    it('stays silent in production when the token is missing', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', '')
      vi.stubEnv('NODE_ENV', 'production')
      expect(warnIfAnalyticsMisconfigured()).toBe(false)
      expect(warn).not.toHaveBeenCalled()
    })

    it('stays silent on self-hosted: off is deliberate, not a misconfiguration', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', '')
      vi.stubEnv('NODE_ENV', 'development')
      expect(warnIfAnalyticsMisconfigured()).toBe(false)
      expect(warn).not.toHaveBeenCalled()
    })
  })
})
