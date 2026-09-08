import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchVapidPublicKey,
  isPushApiSupported,
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
