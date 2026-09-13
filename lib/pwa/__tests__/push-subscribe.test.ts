import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchVapidPublicKey,
  isInstalledWebApp,
  isPushApiSupported,
  sendTestPush,
  unsubscribeFromPush,
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

describe('unsubscribeFromPush', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('re-persists the endpoint when browser unsubscribe fails', async () => {
    const unsubscribe = vi.fn().mockRejectedValue(new Error('browser-fail'))
    const subscription = {
      endpoint: 'https://push.example/sub',
      unsubscribe,
      toJSON: () => ({
        endpoint: 'https://push.example/sub',
        keys: { p256dh: 'p', auth: 'a' },
      }),
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: true }),
      PushManager: function PushManager() {},
      Notification: function Notification() {},
      setTimeout,
    })
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) },
        }),
      },
      standalone: true,
    })
    vi.stubGlobal('PushManager', function PushManager() {})
    vi.stubGlobal('Notification', function Notification() {})

    await expect(unsubscribeFromPush()).rejects.toThrow('browser-fail')
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE' })
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' })
  })
})
