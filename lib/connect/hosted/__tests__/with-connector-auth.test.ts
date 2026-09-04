import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const validateMock = vi.fn()
vi.mock('../keys', () => ({
  validateConnectorKey: (...args: unknown[]) => validateMock(...args),
}))

const usageInsert = vi.fn()
const from = vi.fn(() => ({ insert: usageInsert }))
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => ({ from }),
}))

import { extractConnectorKey, withConnectorAuth, redactEndpoint } from '../with-connector-auth'

const VALID = {
  ok: true,
  key: {
    id: '11111111-1111-4111-8111-111111111111',
    orgNumber: '5561234567',
    instanceUrl: null,
    scopes: ['bank_sync'],
    status: 'active',
    currentPeriodEnd: null,
  },
}

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://app.gnubok.se/api/connect/entitlements', { headers })
}

beforeEach(() => {
  vi.clearAllMocks()
  usageInsert.mockResolvedValue({ error: null })
})

describe('extractConnectorKey', () => {
  it('takes a connector-prefixed Bearer, else X-Connector-Key, else the raw Bearer for the format-check 401', () => {
    expect(extractConnectorKey(req({ authorization: 'Bearer gnubok_ck_a' }))).toBe('gnubok_ck_a')
    expect(extractConnectorKey(req({ 'x-connector-key': 'gnubok_ck_b' }))).toBe('gnubok_ck_b')
    // A connector-prefixed Bearer is unambiguous and wins.
    expect(extractConnectorKey(req({ authorization: 'Bearer gnubok_ck_a', 'x-connector-key': 'gnubok_ck_b' }))).toBe('gnubok_ck_a')
    // The proxied-call shape (SKV data proxy): Authorization is the user's
    // upstream SKV token, X-Connector-Key authenticates the instance. The
    // connector key MUST win or every such request 401s on a hashed upstream
    // token.
    expect(extractConnectorKey(req({ authorization: 'Bearer upstream-skv-token', 'x-connector-key': 'gnubok_ck_b' }))).toBe('gnubok_ck_b')
    // Non-prefixed Bearer alone still reaches the format check (401).
    expect(extractConnectorKey(req({ authorization: 'Bearer not-a-connector-key' }))).toBe('not-a-connector-key')
    expect(extractConnectorKey(req())).toBeNull()
    expect(extractConnectorKey(req({ authorization: 'Basic xyz' }))).toBeNull()
  })
})

describe('redactEndpoint', () => {
  it('replaces opaque handle segments with :id so raw EB session ids never rest in metering', () => {
    expect(redactEndpoint('/api/connect/bank/sessions/8f14e45f-ceea-467f-a8d5-91be6ce7cbc4')).toBe(
      '/api/connect/bank/sessions/:id',
    )
    expect(redactEndpoint('/api/connect/bank/accounts/9a1b2c3d-0000-4111-8222-333344445555/transactions')).toBe(
      '/api/connect/bank/accounts/:id/transactions',
    )
    expect(redactEndpoint('/api/connect/bank/sessions/deadbeefdeadbeefdeadbeef')).toBe('/api/connect/bank/sessions/:id')
    expect(redactEndpoint('/api/connect/bank/sessions/8f14e45f%2Dceea-467f-a8d5-91be6ce7cbc4')).toBe(
      '/api/connect/bank/sessions/:id',
    )
    expect(redactEndpoint('/api/connect/entitlements')).toBe('/api/connect/entitlements')
    expect(redactEndpoint('/api/connect/bank/aspsps')).toBe('/api/connect/bank/aspsps')
  })
})

describe('withConnectorAuth', () => {
  const handler = vi.fn(async (_req: Request, _ctx: { key: { id: string } }) => NextResponse.json({ data: 'ok' }))
  const wrapped = withConnectorAuth('connect.entitlements', handler)

  it('401 without a key, and never calls the handler', async () => {
    const res = await wrapped(req())
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'CONNECTOR_KEY_MISSING' })
    expect(handler).not.toHaveBeenCalled()
    expect(validateMock).not.toHaveBeenCalled()
  })

  it('passes the validation failure through (401/403/429) with its code', async () => {
    for (const failure of [
      { ok: false, status: 401, code: 'CONNECTOR_KEY_INVALID', error: 'Invalid connector key' },
      { ok: false, status: 403, code: 'CONNECTOR_KEY_SUSPENDED', error: 'Connector key is suspended' },
      { ok: false, status: 429, code: 'CONNECTOR_RATE_LIMITED', error: 'Rate limit exceeded' },
    ]) {
      validateMock.mockResolvedValueOnce(failure)
      const res = await wrapped(req({ authorization: 'Bearer gnubok_ck_x' }))
      expect(res.status).toBe(failure.status)
      expect(await res.json()).toEqual({ error: failure.error, code: failure.code })
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it('runs the handler with the validated key and records one usage event', async () => {
    validateMock.mockResolvedValueOnce(VALID)
    const res = await wrapped(req({ authorization: 'Bearer gnubok_ck_x' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Request-Id')).toMatch(/^conn_/)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][1].key.id).toBe(VALID.key.id)
    expect(from).toHaveBeenCalledWith('connector_usage_events')
    expect(usageInsert).toHaveBeenCalledWith({
      connector_key_id: VALID.key.id,
      service: 'entitlements',
      endpoint: '/api/connect/entitlements',
      status_code: 200,
    })
  })

  it('turns a throwing handler into a 500 envelope and still meters it', async () => {
    validateMock.mockResolvedValueOnce(VALID)
    const boom = withConnectorAuth('connect.entitlements', async () => {
      throw new Error('db down')
    })
    const res = await boom(req({ authorization: 'Bearer gnubok_ck_x' }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal error', code: 'INTERNAL_ERROR' })
    expect(usageInsert).toHaveBeenCalledWith(expect.objectContaining({ status_code: 500 }))
  })
})
