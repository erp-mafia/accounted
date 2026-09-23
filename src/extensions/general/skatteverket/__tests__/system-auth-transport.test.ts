/**
 * mTLS token transport: the node:https request/response wiring. Notably the
 * response-stream 'error' path: a mid-body failure happens after headers, so
 * it surfaces on res, not req; without a res error listener the fetchToken
 * promise would hang and the unhandled 'error' event would crash Node.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

const mockRequest = vi.fn()
vi.mock('node:https', () => ({
  default: { request: (...a: unknown[]) => mockRequest(...a) },
}))

import { mtlsTransport } from '../lib/system-auth/transport'

type FakeRes = EventEmitter & { statusCode: number }

function makeFakeReq(onEnd: () => void) {
  const req = new EventEmitter() as EventEmitter & {
    write: (chunk: unknown) => void
    end: () => void
    destroy: (err?: Error) => void
  }
  req.write = vi.fn()
  req.end = () => queueMicrotask(onEnd)
  req.destroy = (err?: Error) => {
    if (err) req.emit('error', err)
  }
  return req
}

/** Wire mockRequest so that ending the request produces the given response events. */
function respondWith(statusCode: number, emit: (res: FakeRes) => void) {
  mockRequest.mockImplementation((_options: unknown, onResponse: (res: FakeRes) => void) => {
    const res = Object.assign(new EventEmitter(), { statusCode }) as FakeRes
    return makeFakeReq(() => {
      onResponse(res)
      emit(res)
    })
  })
}

const ENV_KEYS = [
  'SKATTEVERKET_SYSTEM_OAUTH_TOKEN_URL',
  'SKATTEVERKET_SYSTEM_CERT_PEM_B64',
  'SKATTEVERKET_SYSTEM_KEY_PEM_B64',
]
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  vi.clearAllMocks()
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.SKATTEVERKET_SYSTEM_OAUTH_TOKEN_URL = 'https://oauth2.test.skatteverket.se/token'
  process.env.SKATTEVERKET_SYSTEM_CERT_PEM_B64 = Buffer.from(
    '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----'
  ).toString('base64')
  process.env.SKATTEVERKET_SYSTEM_KEY_PEM_B64 = Buffer.from(
    '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----'
  ).toString('base64')
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('mtlsTransport.fetchToken', () => {
  it('resolves a token from a clean 200 response', async () => {
    respondWith(200, (res) => {
      res.emit('data', Buffer.from('{"access_token":"tok-1",'))
      res.emit('data', Buffer.from('"expires_in":600}'))
      res.emit('end')
    })

    const result = await mtlsTransport.fetchToken(['skattekonto'])
    expect(result.accessToken).toBe('tok-1')
    expect(result.expiresAt).toBeGreaterThan(Date.now())
  })

  it('rejects when the response stream errors mid-body instead of hanging', async () => {
    respondWith(200, (res) => {
      res.emit('data', Buffer.from('{"access_token":"tok'))
      res.emit('error', new Error('socket hang up'))
    })

    await expect(mtlsTransport.fetchToken(['skattekonto'])).rejects.toThrow('socket hang up')
  })

  it('rejects on a non-2xx token endpoint answer', async () => {
    respondWith(401, (res) => {
      res.emit('data', Buffer.from('{"error":"invalid_client"}'))
      res.emit('end')
    })

    await expect(mtlsTransport.fetchToken([])).rejects.toThrow('401')
  })

  it('rejects on request-level errors (pre-response)', async () => {
    mockRequest.mockImplementation(() => {
      const req = makeFakeReq(() => {})
      req.end = () => queueMicrotask(() => req.emit('error', new Error('ECONNREFUSED')))
      return req
    })

    await expect(mtlsTransport.fetchToken([])).rejects.toThrow('ECONNREFUSED')
  })
})
