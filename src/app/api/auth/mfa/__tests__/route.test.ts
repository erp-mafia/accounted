import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseJsonResponse } from '@/tests/helpers'

/**
 * The four MFA session routes (status, enrol, verify, unenrol). They run at
 * AAL1 on purpose, so each authenticates the session itself (getUser).
 */

const state = vi.hoisted(() => ({
  user: null as null | { id: string; factors?: Array<Record<string, unknown>> },
  aal: 'aal1',
  enroll: vi.fn(),
  unenroll: vi.fn(),
  challenge: vi.fn(),
  verify: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: state.user }, error: state.user ? null : { status: 401 } })),
      getClaims: vi.fn(async () => ({ data: { claims: { sub: 'user-1', aal: state.aal, aud: 'authenticated' } }, error: null })),
      mfa: {
        enroll: state.enroll,
        unenroll: state.unenroll,
        challenge: state.challenge,
        verify: state.verify,
      },
    },
  })),
}))

const rateLimitMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/rate-limit-http', () => ({
  checkRateLimit: (...args: unknown[]) => rateLimitMock(...args),
}))

import { GET as getStatus } from '../route'
import { POST as enroll } from '../enroll/route'
import { POST as verify } from '../verify/route'
import { POST as unenroll } from '../unenroll/route'

const FACTOR_ID = '5c0a2f5e-7d2b-4b0e-9a55-6f1f3f3b8a11'

function post(path: string, body: unknown): Request {
  return new Request(`https://app.accounted.se${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  rateLimitMock.mockResolvedValue({ ok: true })
  state.user = {
    id: 'user-1',
    factors: [
      { id: FACTOR_ID, status: 'verified', factor_type: 'totp', friendly_name: 'accounted' },
      { id: 'stale-1', status: 'unverified', factor_type: 'totp', friendly_name: 'accounted' },
    ],
  }
  state.aal = 'aal1'
  state.enroll.mockResolvedValue({ data: { id: 'new-factor', totp: { qr_code: 'data:image/svg+xml;x', secret: 'SECRET', uri: 'otpauth://x' } }, error: null })
  state.unenroll.mockResolvedValue({ data: {}, error: null })
  state.challenge.mockResolvedValue({ data: { id: 'challenge-1' }, error: null })
  state.verify.mockResolvedValue({ data: {}, error: null })
})

describe('GET /api/auth/mfa', () => {
  it('401s without a session', async () => {
    state.user = null
    expect((await getStatus()).status).toBe(401)
  })

  it('lists the server-side factors and both assurance levels', async () => {
    const res = await getStatus()
    const { body } = await parseJsonResponse<{ data: { factors: unknown[]; currentLevel: string; nextLevel: string } }>(res)
    expect(res.status).toBe(200)
    expect(body.data.factors).toHaveLength(2)
    expect(body.data.currentLevel).toBe('aal1')
    expect(body.data.nextLevel).toBe('aal2')
  })
})

describe('POST /api/auth/mfa/enroll', () => {
  it('401s without a session', async () => {
    state.user = null
    expect((await enroll(post('/api/auth/mfa/enroll', {}))).status).toBe(401)
    expect(state.enroll).not.toHaveBeenCalled()
  })

  it('removes stale unverified factors, then enrols and returns the QR code and secret', async () => {
    const res = await enroll(post('/api/auth/mfa/enroll', { friendlyName: 'accounted' }))
    const { body } = await parseJsonResponse<{ data: { id: string; qrCode: string; secret: string } }>(res)

    expect(res.status).toBe(200)
    expect(state.unenroll).toHaveBeenCalledTimes(1)
    expect(state.unenroll).toHaveBeenCalledWith({ factorId: 'stale-1' })
    expect(state.enroll).toHaveBeenCalledWith({ factorType: 'totp', friendlyName: 'accounted' })
    expect(body.data).toEqual({ id: 'new-factor', qrCode: 'data:image/svg+xml;x', secret: 'SECRET' })
  })

  it('400s on an oversized friendly name', async () => {
    const res = await enroll(post('/api/auth/mfa/enroll', { friendlyName: 'x'.repeat(100) }))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/auth/mfa/verify', () => {
  it('401s without a session', async () => {
    state.user = null
    expect((await verify(post('/api/auth/mfa/verify', { factorId: FACTOR_ID, code: '123456' }))).status).toBe(401)
  })

  it('400s on a malformed code or factor id', async () => {
    expect((await verify(post('/api/auth/mfa/verify', { factorId: FACTOR_ID, code: '12345' }))).status).toBe(400)
    expect((await verify(post('/api/auth/mfa/verify', { factorId: 'nope', code: '123456' }))).status).toBe(400)
    expect(state.challenge).not.toHaveBeenCalled()
  })

  it('challenges and verifies in one step', async () => {
    const res = await verify(post('/api/auth/mfa/verify', { factorId: FACTOR_ID, code: '123456' }))
    expect(res.status).toBe(200)
    expect(state.verify).toHaveBeenCalledWith({ factorId: FACTOR_ID, challengeId: 'challenge-1', code: '123456' })
  })

  it('tags a failed challenge distinctly from a wrong code', async () => {
    state.challenge.mockResolvedValue({ data: null, error: { status: 422, code: 'mfa_factor_not_found' } })
    const res = await verify(post('/api/auth/mfa/verify', { factorId: FACTOR_ID, code: '123456' }))
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('mfa_challenge_failed')

    state.challenge.mockResolvedValue({ data: { id: 'c2' }, error: null })
    state.verify.mockResolvedValue({ data: null, error: { status: 422, code: 'mfa_verification_failed' } })
    const wrong = await verify(post('/api/auth/mfa/verify', { factorId: FACTOR_ID, code: '000000' }))
    const { body: wrongBody } = await parseJsonResponse<{ error: { code: string } }>(wrong)
    expect(wrongBody.error.code).toBe('mfa_verification_failed')
  })

  it('is limited per user', async () => {
    rateLimitMock.mockResolvedValue({ ok: false })
    const res = await verify(post('/api/auth/mfa/verify', { factorId: FACTOR_ID, code: '123456' }))
    expect(res.status).toBe(429)
    expect((rateLimitMock.mock.calls[0][0] as { identifier: string }).identifier).toBe('user-1')
  })
})

describe('POST /api/auth/mfa/unenroll', () => {
  it('401s without a session', async () => {
    state.user = null
    expect((await unenroll(post('/api/auth/mfa/unenroll', { factorId: FACTOR_ID }))).status).toBe(401)
  })

  it('400s without a factor id', async () => {
    expect((await unenroll(post('/api/auth/mfa/unenroll', {}))).status).toBe(400)
  })

  it("passes GoTrue's AAL2 refusal through, so the settings page can step up", async () => {
    state.unenroll.mockResolvedValue({ data: null, error: { status: 403, code: 'insufficient_aal', message: 'AAL2 required to unenroll verified factor' } })
    const res = await unenroll(post('/api/auth/mfa/unenroll', { factorId: FACTOR_ID }))
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('insufficient_aal')
  })

  it('removes the factor', async () => {
    const res = await unenroll(post('/api/auth/mfa/unenroll', { factorId: FACTOR_ID }))
    expect(res.status).toBe(200)
    expect(state.unenroll).toHaveBeenCalledWith({ factorId: FACTOR_ID })
  })
})
