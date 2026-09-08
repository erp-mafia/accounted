import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchVapidPublicKey,
  isInstalledWebApp,
  isPushApiSupported,
  sendTestPush,
  urlBase64ToUint8Array,
} from '@/lib/pwa/push-subscribe'

describe('urlBase64ToUint8Array', () => {
  it('decodes URL-safe base64 without padding', () => {
    const bytes = urlBase64ToUint8Array('AQID')
    expect(Array.from(bytes)).toEqual([1, 2, 3])
  })
})

describe('isPushApiSupported', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is false without PushManager', () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', {})
    expect(isPushApiSupported()).toBe(false)
  })
})

describe('isInstalledWebApp', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is true for display-mode standalone', () => {
    vi.stubGlobal('window', {
      matchMedia: (query: string) => ({
        matches: query.includes('standalone'),
      }),
    })
    vi.stubGlobal('navigator', {})
    expect(isInstalledWebApp()).toBe(true)
  })

  it('is true for iOS navigator.standalone', () => {
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
    })
    vi.stubGlobal('navigator', { standalone: true })
    expect(isInstalledWebApp()).toBe(true)
  })
})

describe('fetchVapidPublicKey', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns null when the extension is off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'Extension not found' }),
      }),
    )
    await expect(fetchVapidPublicKey()).resolves.toBeNull()
  })

  it('returns the public key when configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ vapidPublicKey: 'synthetic-public' }),
      }),
    )
    await expect(fetchVapidPublicKey()).resolves.toBe('synthetic-public')
  })
})

describe('sendTestPush', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns sent on 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))
    await expect(sendTestPush()).resolves.toBe('sent')
  })

  it('returns no_subscriptions on 409', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409 }))
    await expect(sendTestPush()).resolves.toBe('no_subscriptions')
  })
})
