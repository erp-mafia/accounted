import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseJsonResponse } from '@/tests/helpers'

/**
 * Security keys as a second factor (crm#1448): enrol, challenge, verify.
 * Enrolment sits behind NEXT_PUBLIC_WEBAUTHN_MFA_ENABLED (default off: 404);
 * signing in with a key that already exists does not, so switching the flag
 * off never strands a key holder at /mfa/verify.
 */

const state = vi.hoisted(() => ({
  user: null as null | { id: string; factors?: Array<Record<string, unknown>> },
  enroll: vi.fn(),
  unenroll: vi.fn(),
  challenge: vi.fn(),
  verify: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: state.user }, error: state.user ? null : { status: 401 } })),
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

vi.mock('@/lib/domains/trusted-app-origin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/domains/trusted-app-origin')>()),
  resolveRequestAppOrigin: vi.fn(async () => 'https://app.accounted.se'),
}))

import { POST as enroll } from '../enroll/route'
import { POST as challenge } from '../challenge/route'
import { POST as verify } from '../verify/route'

const KEY_ID = '7d4e1c2a-1b3c-4d5e-8f90-a1b2c3d4e5f6'
const NEW_KEY_ID = '0f9e8d7c-6b5a-4c3d-9e2f-1a0b9c8d7e6f'
const CHALLENGE_ID = '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d'
const RP = { rpId: 'app.accounted.se', rpOrigins: ['https://app.accounted.se'] }
const CREDENTIAL = {
  id: 'cred-id',
  rawId: 'cred-id',
  type: 'public-key',
  response: { clientDataJSON: 'Y2xpZW50', attestationObject: 'YXR0ZXN0' },
  clientExtensionResults: {},
}

function post(path: string, body: unknown): Request {
  return new Request(`https://app.accounted.se${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_WEBAUTHN_MFA_ENABLED', 'true')
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
  rateLimitMock.mockResolvedValue({ ok: true })
  state.user = {
    id: 'user-1',
    factors: [
      { id: 'totp-1', status: 'verified', factor_type: 'totp' },
      { id: KEY_ID, status: 'verified', factor_type: 'webauthn' },
      { id: NEW_KEY_ID, status: 'unverified', factor_type: 'webauthn' },
      { id: 'stale-totp', status: 'unverified', factor_type: 'totp' },
    ],
  }
  state.enroll.mockResolvedValue({ data: { id: NEW_KEY_ID, type: 'webauthn' }, error: null })
  state.unenroll.mockResolvedValue({ data: {}, error: null })
  state.verify.mockResolvedValue({ data: {}, error: null })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/auth/mfa/webauthn/enroll', () => {
  beforeEach(() => {
    state.challenge.mockResolvedValue({
      data: {
        id: CHALLENGE_ID,
        type: 'webauthn',
        webauthn: {
          type: 'create',
          credential_options: {
            publicKey: { challenge: new Uint8Array([1, 2, 3]).buffer, user: { id: new Uint8Array([255]).buffer, name: 'u' } },
          },
        },
      },
      error: null,
    })
  })

  it('404s while the flag is off and never reaches GoTrue', async () => {
    vi.stubEnv('NEXT_PUBLIC_WEBAUTHN_MFA_ENABLED', '')
    const res = await enroll(post('/api/auth/mfa/webauthn/enroll', {}))
    expect(res.status).toBe(404)
    expect(state.enroll).not.toHaveBeenCalled()
  })

  it('401s without a session', async () => {
    state.user = null
    expect((await enroll(post('/api/auth/mfa/webauthn/enroll', {}))).status).toBe(401)
    expect(state.enroll).not.toHaveBeenCalled()
  })

  it('400s on an oversized friendly name', async () => {
    expect((await enroll(post('/api/auth/mfa/webauthn/enroll', { friendlyName: 'x'.repeat(100) }))).status).toBe(400)
  })

  it('removes only stale security-key factors, enrols, and returns JSON creation options', async () => {
    const res = await enroll(post('/api/auth/mfa/webauthn/enroll', {}))
    const { body } = await parseJsonResponse<{ data: { factorId: string; challengeId: string; publicKey: Record<string, unknown> } }>(res)

    expect(res.status).toBe(200)
    expect(state.unenroll).toHaveBeenCalledTimes(1)
    expect(state.unenroll).toHaveBeenCalledWith({ factorId: NEW_KEY_ID })
    // One verified key already: the default name is numbered past it.
    expect(state.enroll).toHaveBeenCalledWith({ factorType: 'webauthn', friendlyName: 'Säkerhetsnyckel 2' })
    expect(state.challenge).toHaveBeenCalledWith({ factorId: NEW_KEY_ID, webauthn: RP })
    expect(body.data.factorId).toBe(NEW_KEY_ID)
    expect(body.data.challengeId).toBe(CHALLENGE_ID)
    expect(body.data.publicKey).toEqual({ challenge: 'AQID', user: { id: '_w', name: 'u' } })
  })

  it('passes a GoTrue refusal through (an existing factor holder below AAL2)', async () => {
    state.enroll.mockResolvedValue({ data: null, error: { status: 403, code: 'insufficient_aal', message: 'AAL2 required' } })
    const res = await enroll(post('/api/auth/mfa/webauthn/enroll', {}))
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('insufficient_aal')
  })
})

describe('POST /api/auth/mfa/webauthn/challenge', () => {
  beforeEach(() => {
    state.challenge.mockResolvedValue({
      data: {
        id: CHALLENGE_ID,
        type: 'webauthn',
        webauthn: { type: 'request', credential_options: { publicKey: { challenge: new Uint8Array([9]).buffer } } },
      },
      error: null,
    })
  })

  it('401s without a session', async () => {
    state.user = null
    expect((await challenge(post('/api/auth/mfa/webauthn/challenge', { factorId: KEY_ID }))).status).toBe(401)
  })

  it('400s on a malformed factor id', async () => {
    expect((await challenge(post('/api/auth/mfa/webauthn/challenge', { factorId: 'nope' }))).status).toBe(400)
  })

  it('404s for a factor that is not a verified security key of this user', async () => {
    for (const factorId of ['5c0a2f5e-7d2b-4b0e-9a55-6f1f3f3b8a11', NEW_KEY_ID]) {
      expect((await challenge(post('/api/auth/mfa/webauthn/challenge', { factorId }))).status).toBe(404)
    }
    expect(state.challenge).not.toHaveBeenCalled()
  })

  it('returns JSON request options, also while the enrolment flag is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_WEBAUTHN_MFA_ENABLED', '')
    const res = await challenge(post('/api/auth/mfa/webauthn/challenge', { factorId: KEY_ID }))
    const { body } = await parseJsonResponse<{ data: { challengeId: string; publicKey: Record<string, unknown> } }>(res)
    expect(res.status).toBe(200)
    expect(state.challenge).toHaveBeenCalledWith({ factorId: KEY_ID, webauthn: RP })
    expect(body.data).toEqual({ challengeId: CHALLENGE_ID, publicKey: { challenge: 'CQ' } })
  })
})

describe('POST /api/auth/mfa/webauthn/verify', () => {
  const signIn = { factorId: KEY_ID, challengeId: CHALLENGE_ID, type: 'request', credential: CREDENTIAL }
  const register = { factorId: NEW_KEY_ID, challengeId: CHALLENGE_ID, type: 'create', credential: CREDENTIAL }

  it('401s without a session', async () => {
    state.user = null
    expect((await verify(post('/api/auth/mfa/webauthn/verify', signIn))).status).toBe(401)
  })

  it('400s on a malformed body', async () => {
    expect((await verify(post('/api/auth/mfa/webauthn/verify', { ...signIn, type: 'other' }))).status).toBe(400)
    expect((await verify(post('/api/auth/mfa/webauthn/verify', { ...signIn, credential: { id: 'x' } }))).status).toBe(400)
    expect(state.verify).not.toHaveBeenCalled()
  })

  it('404s on a factor in the wrong state for the ceremony', async () => {
    expect((await verify(post('/api/auth/mfa/webauthn/verify', { ...signIn, factorId: NEW_KEY_ID }))).status).toBe(404)
    expect((await verify(post('/api/auth/mfa/webauthn/verify', { ...register, factorId: KEY_ID }))).status).toBe(404)
    expect(state.verify).not.toHaveBeenCalled()
  })

  it('404s a registration while the flag is off, but still signs a key holder in', async () => {
    vi.stubEnv('NEXT_PUBLIC_WEBAUTHN_MFA_ENABLED', '')
    expect((await verify(post('/api/auth/mfa/webauthn/verify', register))).status).toBe(404)
    expect((await verify(post('/api/auth/mfa/webauthn/verify', signIn))).status).toBe(200)
  })

  it('verifies with the relying party and hands auth-js the browser JSON unchanged', async () => {
    const res = await verify(post('/api/auth/mfa/webauthn/verify', register))
    expect(res.status).toBe(200)
    const params = state.verify.mock.calls[0][0] as {
      factorId: string
      challengeId: string
      webauthn: { rpId: string; rpOrigins: string[]; type: string; credential_response: { toJSON: () => unknown } }
    }
    expect(params.factorId).toBe(NEW_KEY_ID)
    expect(params.challengeId).toBe(CHALLENGE_ID)
    expect(params.webauthn.rpId).toBe('app.accounted.se')
    expect(params.webauthn.rpOrigins).toEqual(['https://app.accounted.se'])
    expect(params.webauthn.type).toBe('create')
    expect(params.webauthn.credential_response.toJSON()).toEqual(CREDENTIAL)
  })

  it('passes a failed verification through', async () => {
    state.verify.mockResolvedValue({ data: null, error: { status: 422, code: 'mfa_verification_failed' } })
    const res = await verify(post('/api/auth/mfa/webauthn/verify', signIn))
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('mfa_verification_failed')
  })

  it('is limited per user', async () => {
    rateLimitMock.mockResolvedValue({ ok: false })
    const res = await verify(post('/api/auth/mfa/webauthn/verify', signIn))
    expect(res.status).toBe(429)
  })
})
