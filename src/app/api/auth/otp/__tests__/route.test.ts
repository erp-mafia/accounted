import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseJsonResponse } from '@/tests/helpers'

const verifyOtpMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { verifyOtp: verifyOtpMock } })),
}))

const rateLimitMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/rate-limit-http', () => ({
  checkRateLimit: (...args: unknown[]) => rateLimitMock(...args),
}))

import { POST } from '../route'

function makeRequest(body: unknown): Request {
  return new Request('https://app.accounted.se/api/auth/otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  rateLimitMock.mockResolvedValue({ ok: true })
  verifyOtpMock.mockResolvedValue({
    data: { user: { id: 'user-1', factors: [] }, session: { access_token: 'h.e30.s' } },
    error: null,
  })
})

describe('POST /api/auth/otp', () => {
  it('400s on an unknown type or a malformed code', async () => {
    expect((await POST(makeRequest({ type: 'signup', token_hash: 'x' }))).status).toBe(400)
    expect((await POST(makeRequest({ type: 'recovery', email: 'a@b.se', token: '12ab' }))).status).toBe(400)
    expect(verifyOtpMock).not.toHaveBeenCalled()
  })

  it('exchanges the BankID magic link and records the BankID method (HttpOnly)', async () => {
    const res = await POST(makeRequest({ type: 'magiclink', token_hash: 'hashed-token' }))

    expect(res.status).toBe(200)
    expect(verifyOtpMock).toHaveBeenCalledWith({ token_hash: 'hashed-token', type: 'magiclink' })
    expect(res.cookies.get('gnubok-auth-method')).toMatchObject({ value: 'bankid', httpOnly: true })
  })

  it('verifies a typed recovery code (8 digits allowed) without a method hint', async () => {
    const res = await POST(makeRequest({ type: 'recovery', email: 'Kund@Example.com', token: '12345678' }))

    expect(res.status).toBe(200)
    expect(verifyOtpMock).toHaveBeenCalledWith({ email: 'kund@example.com', token: '12345678', type: 'recovery' })
    expect(res.cookies.get('gnubok-auth-method')).toBeUndefined()
    // The typed-code variant is limited per address as well.
    expect(rateLimitMock).toHaveBeenCalledTimes(2)
  })

  it("passes GoTrue's refusal through (burned or expired link)", async () => {
    verifyOtpMock.mockResolvedValue({
      data: { user: null, session: null },
      error: { code: 'otp_expired', status: 403, message: 'Token has expired or is invalid' },
    })
    const res = await POST(makeRequest({ type: 'recovery', token_hash: 'old' }))
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('otp_expired')
  })

  it('reports an owed MFA step-up for a recovery session of an MFA user', async () => {
    const payload = Buffer.from(JSON.stringify({ aal: 'aal1' })).toString('base64url')
    verifyOtpMock.mockResolvedValue({
      data: {
        user: { id: 'user-1', factors: [{ id: 'f', status: 'verified' }] },
        session: { access_token: `h.${payload}.s` },
      },
      error: null,
    })
    const res = await POST(makeRequest({ type: 'recovery', token_hash: 'fresh' }))
    const { body } = await parseJsonResponse<{ data: { mfaRequired: boolean } }>(res)
    expect(body.data.mfaRequired).toBe(true)
  })
})
