import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse } from '@/tests/helpers'

const signUpMock = vi.hoisted(() => vi.fn())
// The signup acceptance rows go through the service client (no session yet).
const acceptanceUpsertMock = vi.hoisted(() => vi.fn())
const serviceFromMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { signUp: signUpMock } })),
  createServiceClient: vi.fn(() => ({ from: serviceFromMock })),
}))

const gateMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/brand-signup-gate', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/auth/brand-signup-gate')>()
  return {
    ...actual,
    evaluateBrandSignupGate: (...args: unknown[]) => gateMock(...args),
  }
})

const resolveBrandResultByHostMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandResultByHost: (...args: unknown[]) => resolveBrandResultByHostMock(...args),
}))

import { POST } from '../route'
import { ACCEPTED_DOCUMENTS, LEGAL_DOCUMENTS } from '@/lib/legal/documents'

function makeRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request('https://internal/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const validBody = { email: 'kund@example.com', password: 'Str0ng!Pass' }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.se'
  // app.testbrand.example is a registered brand host; app.accounted.se is
  // the canonical host and never consults the registry.
  resolveBrandResultByHostMock.mockImplementation(async (host: string) => ({
    brand: host === 'app.testbrand.example' ? { domain: host } : null,
    lookupFailed: false,
  }))
  gateMock.mockResolvedValue({ allowed: true, brand: null, via: 'no_brand' })
  signUpMock.mockResolvedValue({
    data: { user: { identities: [{ id: 'i1' }] }, session: null },
    error: null,
  })
  acceptanceUpsertMock.mockResolvedValue({ error: null })
  serviceFromMock.mockImplementation(() => ({ upsert: acceptanceUpsertMock }))
})

describe('POST /api/auth/signup', () => {
  it('400s on invalid body', async () => {
    const res = await POST(makeRequest({ email: 'not-an-email', password: 'x' }))
    expect(res.status).toBe(400)
    expect(signUpMock).not.toHaveBeenCalled()
  })

  it('403s with signup_not_allowed when the gate blocks', async () => {
    gateMock.mockResolvedValue({ allowed: false, brand: { id: 'brand-1' } })

    const res = await POST(
      makeRequest(validBody, { host: 'app.testbrand.example' }),
    )
    const { body: json } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(res.status).toBe(403)
    expect(json.error.code).toBe('signup_not_allowed')
    expect(signUpMock).not.toHaveBeenCalled()
  })

  it('503s (fail safe) when the brand lookup errors, without creating an account', async () => {
    gateMock.mockResolvedValue({ allowed: false, brand: null, lookupFailed: true })

    const res = await POST(
      makeRequest(validBody, { host: 'app.testbrand.example' }),
    )
    const { body: json } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(res.status).toBe(503)
    expect(json.error.code).toBe('brand_lookup_failed')
    expect(signUpMock).not.toHaveBeenCalled()
  })

  it('feeds the gate the forwarded host, normalized email and invite cookie', async () => {
    await POST(
      makeRequest(
        { ...validBody, email: '  Kund@Example.COM ' },
        {
          host: 'internal',
          'x-forwarded-host': 'app.testbrand.example',
          cookie: 'gnubok-invite-token=gnubok_inv_x',
        },
      ),
    )

    expect(gateMock).toHaveBeenCalledWith({
      host: 'app.testbrand.example',
      email: 'kund@example.com',
      inviteToken: 'gnubok_inv_x',
    })
  })

  it('signs up with a confirmation callback on the originating host', async () => {
    const res = await POST(
      makeRequest(validBody, {
        'x-forwarded-host': 'app.testbrand.example',
        'x-forwarded-proto': 'https',
      }),
    )
    const { body: json } = await parseJsonResponse<{ data: { status: string } }>(res)

    expect(res.status).toBe(200)
    expect(json.data.status).toBe('confirmation_sent')
    expect(signUpMock).toHaveBeenCalledWith({
      email: 'kund@example.com',
      password: 'Str0ng!Pass',
      options: {
        emailRedirectTo: 'https://app.testbrand.example/auth/callback',
      },
    })
  })

  it('forwards the captcha token and a safe next path', async () => {
    await POST(
      makeRequest(
        { ...validBody, captchaToken: 'tok', next: '/api/mcp-oauth/authorize?x=1' },
        { host: 'app.accounted.se' },
      ),
    )

    const call = signUpMock.mock.calls[0][0]
    expect(call.options.captchaToken).toBe('tok')
    expect(call.options.emailRedirectTo).toBe(
      'https://app.accounted.se/auth/callback?next=%2Fapi%2Fmcp-oauth%2Fauthorize%3Fx%3D1',
    )
  })

  it('drops an unsafe next path instead of forwarding it', async () => {
    await POST(
      makeRequest(
        { ...validBody, next: 'https://evil.example.com/phish' },
        { host: 'app.accounted.se' },
      ),
    )
    const call = signUpMock.mock.calls[0][0]
    expect(call.options.emailRedirectTo).toBe(
      'https://app.accounted.se/auth/callback',
    )
  })

  it('maps a GoTrue error to the canonical envelope', async () => {
    signUpMock.mockResolvedValue({
      data: { user: null, session: null },
      error: { code: 'weak_password', message: 'Password is too weak', status: 422 },
    })

    const res = await POST(makeRequest(validBody, { host: 'app.accounted.se' }))
    const { body: json } = await parseJsonResponse<{ error: { code: string; message: string } }>(res)

    expect(res.status).toBe(422)
    expect(json.error.code).toBe('weak_password')
  })

  it('reports duplicate for the obfuscated existing-account response', async () => {
    signUpMock.mockResolvedValue({
      data: { user: { identities: [] }, session: null },
      error: null,
    })

    const res = await POST(makeRequest(validBody, { host: 'app.accounted.se' }))
    const { body: json } = await parseJsonResponse<{ data: { status: string } }>(res)

    expect(json.data.status).toBe('duplicate')
  })

  it('reports session for auto-confirmed signups', async () => {
    signUpMock.mockResolvedValue({
      data: { user: { identities: [{ id: 'i1' }] }, session: { access_token: 'x' } },
      error: null,
    })

    const res = await POST(makeRequest(validBody, { host: 'app.accounted.se' }))
    const { body: json } = await parseJsonResponse<{ data: { status: string } }>(res)

    expect(json.data.status).toBe('session')
  })
})

describe('POST /api/auth/signup: acceptance of the terms at signup', () => {
  const newAccount = { user: { id: 'new-user', identities: [{ id: 'i1' }] }, session: null }

  it('records every accepted document at its current version for a new account', async () => {
    signUpMock.mockResolvedValue({ data: newAccount, error: null })

    const res = await POST(makeRequest(validBody, { host: 'app.accounted.se' }))

    expect(res.status).toBe(200)
    expect(serviceFromMock).toHaveBeenCalledWith('legal_acceptances')
    expect(acceptanceUpsertMock.mock.calls.map(([row]) => row)).toEqual(
      ACCEPTED_DOCUMENTS.map((key) => ({
        user_id: 'new-user',
        company_id: null,
        document_key: key,
        version: LEGAL_DOCUMENTS[key].acceptanceVersion,
        method: 'signup',
      })),
    )
  })

  it('records nothing for the obfuscated duplicate, which created no account', async () => {
    signUpMock.mockResolvedValue({
      data: { user: { id: 'fake-id', identities: [] }, session: null },
      error: null,
    })

    const res = await POST(makeRequest(validBody, { host: 'app.accounted.se' }))
    const { body: json } = await parseJsonResponse<{ data: { status: string } }>(res)

    expect(json.data.status).toBe('duplicate')
    expect(acceptanceUpsertMock).not.toHaveBeenCalled()
  })

  it('records nothing when GoTrue refuses the signup', async () => {
    signUpMock.mockResolvedValue({
      data: { user: null, session: null },
      error: { status: 422, code: 'weak_password', message: 'weak' },
    })

    const res = await POST(makeRequest(validBody, { host: 'app.accounted.se' }))

    expect(res.status).toBe(422)
    expect(acceptanceUpsertMock).not.toHaveBeenCalled()
  })

  it('still answers the signup when the acceptance cannot be stored', async () => {
    signUpMock.mockResolvedValue({ data: newAccount, error: null })
    acceptanceUpsertMock.mockResolvedValue({ error: { message: 'down' } })

    const res = await POST(makeRequest(validBody, { host: 'app.accounted.se' }))
    const { body: json } = await parseJsonResponse<{ data: { status: string } }>(res)

    expect(res.status).toBe(200)
    expect(json.data.status).toBe('confirmation_sent')
  })
})
