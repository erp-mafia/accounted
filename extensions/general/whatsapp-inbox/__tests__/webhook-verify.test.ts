import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'
import {
  verifyMetaSignature,
  verifyChallengeToken,
} from '@/extensions/general/whatsapp-inbox/lib/webhook-verify'
import { whatsappInboxExtension } from '@/extensions/general/whatsapp-inbox'

const SECRET = 'meta-app-secret'

function sign(body: string, secret = SECRET): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

function findRoute(method: string, path: string) {
  return whatsappInboxExtension.apiRoutes!.find((r) => r.method === method && r.path === path)!
}

describe('verifyMetaSignature', () => {
  it('accepts a valid signature', () => {
    const body = '{"object":"whatsapp_business_account"}'
    expect(verifyMetaSignature(body, sign(body), SECRET)).toBe(true)
  })

  it('rejects a signature made with the wrong secret', () => {
    const body = '{"a":1}'
    expect(verifyMetaSignature(body, sign(body, 'forged-secret'), SECRET)).toBe(false)
  })

  it('rejects a signature over a different body', () => {
    expect(verifyMetaSignature('{"a":2}', sign('{"a":1}'), SECRET)).toBe(false)
  })

  it('rejects a malformed (non-hex) header without throwing', () => {
    expect(verifyMetaSignature('{}', 'sha256=zzzz-not-hex', SECRET)).toBe(false)
    expect(verifyMetaSignature('{}', 'sha256=', SECRET)).toBe(false)
    expect(verifyMetaSignature('{}', 'garbage', SECRET)).toBe(false)
  })

  it('rejects a missing header', () => {
    expect(verifyMetaSignature('{}', null, SECRET)).toBe(false)
    expect(verifyMetaSignature('{}', undefined, SECRET)).toBe(false)
  })

  it('rejects when the secret is empty', () => {
    const body = '{}'
    expect(verifyMetaSignature(body, sign(body), '')).toBe(false)
  })
})

describe('verifyChallengeToken', () => {
  it('accepts an exact match', () => {
    expect(verifyChallengeToken('tok-123', 'tok-123')).toBe(true)
  })

  it('rejects mismatches and length differences', () => {
    expect(verifyChallengeToken('tok-124', 'tok-123')).toBe(false)
    expect(verifyChallengeToken('tok-1234', 'tok-123')).toBe(false)
  })

  it('rejects missing values', () => {
    expect(verifyChallengeToken(null, 'tok-123')).toBe(false)
    expect(verifyChallengeToken('tok-123', undefined)).toBe(false)
  })
})

describe('GET /webhook (subscription handshake)', () => {
  const originalEnv = { ...process.env }
  const route = findRoute('GET', '/webhook')

  beforeEach(() => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'verify-token-1'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  function handshakeRequest(params: Record<string, string>): Request {
    const url = new URL('http://localhost:3000/api/extensions/ext/whatsapp-inbox/webhook')
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    return new Request(url.toString(), { method: 'GET' })
  }

  it('echoes hub.challenge as text/plain on a valid handshake', async () => {
    const response = await route.handler(
      handshakeRequest({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-token-1',
        'hub.challenge': '1158201444',
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(await response.text()).toBe('1158201444')
  })

  it('403s on a wrong verify token', async () => {
    const response = await route.handler(
      handshakeRequest({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token',
        'hub.challenge': '1158201444',
      }),
    )
    expect(response.status).toBe(403)
  })

  it('403s on a missing mode', async () => {
    const response = await route.handler(
      handshakeRequest({ 'hub.verify_token': 'verify-token-1', 'hub.challenge': 'x' }),
    )
    expect(response.status).toBe(403)
  })

  it('503s when the verify token env is not configured', async () => {
    delete process.env.WHATSAPP_VERIFY_TOKEN
    const response = await route.handler(
      handshakeRequest({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-token-1',
        'hub.challenge': 'x',
      }),
    )
    expect(response.status).toBe(503)
  })
})
