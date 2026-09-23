import { describe, it, expect, afterEach, vi } from 'vitest'
import { isAllowedSkvPopupOrigin } from '../popup-origin'

const APP = 'https://app.accounted.se'
const OAUTH = 'https://app.gnubok.se'

describe('isAllowedSkvPopupOrigin', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('always allows the window own origin', () => {
    expect(isAllowedSkvPopupOrigin(APP, APP)).toBe(true)
  })

  it('allows the pinned SKV OAuth origin when configured', () => {
    vi.stubEnv('NEXT_PUBLIC_SKV_OAUTH_BASE_URL', OAUTH)
    expect(isAllowedSkvPopupOrigin(OAUTH, APP)).toBe(true)
  })

  it('normalises the pinned base URL to an origin (path/trailing slash ignored)', () => {
    vi.stubEnv('NEXT_PUBLIC_SKV_OAUTH_BASE_URL', `${OAUTH}/`)
    expect(isAllowedSkvPopupOrigin(OAUTH, APP)).toBe(true)
  })

  it('rejects foreign origins even when a pin is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_SKV_OAUTH_BASE_URL', OAUTH)
    expect(isAllowedSkvPopupOrigin('https://evil.example', APP)).toBe(false)
  })

  it('rejects cross-origin messages when no pin is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_SKV_OAUTH_BASE_URL', '')
    expect(isAllowedSkvPopupOrigin(OAUTH, APP)).toBe(false)
  })

  it('rejects cross-origin messages when the pin is malformed', () => {
    vi.stubEnv('NEXT_PUBLIC_SKV_OAUTH_BASE_URL', 'not a url')
    expect(isAllowedSkvPopupOrigin(OAUTH, APP)).toBe(false)
  })
})
