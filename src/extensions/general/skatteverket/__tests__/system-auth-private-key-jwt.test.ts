import crypto from 'crypto'
import { describe, it, expect, vi } from 'vitest'

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const tokenUrl = vi.hoisted(() => ({ value: 'https://sysoauth.test.example/token' }))

vi.mock('../lib/system-auth/config', () => ({
  getSystemAuthMechanism: () => 'private_key_jwt',
  getSystemCaPem: () => null,
  getSystemCertPem: () => null,
  getSystemClientId: () => 'system-client',
  getSystemKeyPassphrase: () => null,
  getSystemKeyPem: () => privateKey,
  getSystemTokenUrl: () => tokenUrl.value,
}))

import { privateKeyJwtTransport } from '../lib/system-auth/transport'

describe('privateKeyJwtTransport', () => {
  it('refuses redirects, so the signed client_assertion never reaches another host', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'sys-tok', expires_in: 600 }), { status: 200 }),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await privateKeyJwtTransport.fetchToken(['agd'])

    expect(result.accessToken).toBe('sys-tok')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://sysoauth.test.example/token')
    expect(new URLSearchParams(init.body as string).get('client_assertion')).toBeTruthy()
    expect(init.redirect).toBe('error')
  })

  it('refuses a plaintext token URL before the signed client_assertion leaves (accounted#21)', async () => {
    tokenUrl.value = 'http://sysoauth.test.example/token'
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    try {
      await expect(privateKeyJwtTransport.fetchToken(['agd'])).rejects.toThrow(
        /SKATTEVERKET_SYSTEM_OAUTH_TOKEN_URL must be https/,
      )
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      tokenUrl.value = 'https://sysoauth.test.example/token'
    }
  })
})
