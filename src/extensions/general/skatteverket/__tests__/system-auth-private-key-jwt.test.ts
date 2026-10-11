import crypto from 'crypto'
import { describe, it, expect, vi } from 'vitest'

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

vi.mock('../lib/system-auth/config', () => ({
  getSystemAuthMechanism: () => 'private_key_jwt',
  getSystemCaPem: () => null,
  getSystemCertPem: () => null,
  getSystemClientId: () => 'system-client',
  getSystemKeyPassphrase: () => null,
  getSystemKeyPem: () => privateKey,
  getSystemTokenUrl: () => 'https://sysoauth.test.example/token',
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
})
