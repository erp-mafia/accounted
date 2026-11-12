import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

import { createServiceClient } from '@/lib/supabase/server'
import { POST } from '../route'

const mockCreateServiceClient = vi.mocked(createServiceClient)

type AuthMetadata = Record<string, unknown>

function mockUserClient(opts: {
  user: { id: string; app_metadata?: AuthMetadata } | null
  updateUserError?: { message: string; status?: number; code?: string } | null
  signOutError?: { message: string; status?: number; code?: string } | null
  // Returned-error from verifyOtp on the link that restores the session.
  verifyOtpError?: { message: string; status?: number; code?: string } | null
}) {
  const updateUser = vi.fn().mockResolvedValue({
    data: {},
    error: opts.updateUserError ?? null,
  })
  const signOut = vi.fn().mockResolvedValue({ error: opts.signOutError ?? null })
  const verifyOtp = vi.fn().mockResolvedValue(
    opts.verifyOtpError
      ? { data: { session: null, user: null }, error: opts.verifyOtpError }
      : { data: { session: { access_token: 'new' }, user: { id: opts.user?.id } }, error: null },
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = { auth: { updateUser, signOut, verifyOtp } } as any

  if (opts.user) {
    // The token's address is deliberately not the auth server's: the route
    // must never mint a session for what the token says.
    const user = { email: 'stale-in-token@example.com', ...opts.user }
    requireAuthMock.mockResolvedValue({ user, supabase, error: null })
  } else {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
  }

  return { updateUser, signOut, verifyOtp }
}

function mockService(opts: {
  priorAppMetadata?: AuthMetadata
  // Returned-error from admin.updateUserById when called with { password }
  passwordSetError?: { message: string; status?: number; code?: string } | null
  // Thrown error from admin.updateUserById when called with { app_metadata }
  flagFlipError?: Error | null
  // Returned-error from admin.generateLink (the link that restores the session)
  generateLinkError?: { message: string; status?: number; code?: string } | null
  // The address the auth server holds for the user (null: none).
  currentEmail?: string | null
  // The user GoTrue says the link belongs to (default: the user asked for).
  linkUserId?: string
}) {
  const updateUserById = vi
    .fn()
    .mockImplementation((_id: string, args: Record<string, unknown>) => {
      if ('password' in args) {
        return Promise.resolve({
          data: {},
          error: opts.passwordSetError ?? null,
        })
      }
      if (opts.flagFlipError) return Promise.reject(opts.flagFlipError)
      return Promise.resolve({ data: {}, error: null })
    })

  const currentEmail = opts.currentEmail === undefined ? 'current@example.com' : opts.currentEmail
  const getUserById = vi.fn().mockImplementation((id: string) =>
    Promise.resolve({
      data: { user: { id, email: currentEmail, app_metadata: opts.priorAppMetadata ?? {} } },
    }),
  )

  const generateLink = vi.fn().mockResolvedValue(
    opts.generateLinkError
      ? { data: null, error: opts.generateLinkError }
      : {
          data: { properties: { hashed_token: 'hashed-token-1' }, user: { id: opts.linkUserId ?? 'user-1' } },
          error: null,
        },
  )

  mockCreateServiceClient.mockReturnValue({
    auth: { admin: { getUserById, updateUserById, generateLink } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  return { getUserById, updateUserById, generateLink }
}

const STRONG_PASSWORD = 'StrongP@ssword1'

function flagFlipCall(updateUserById: ReturnType<typeof vi.fn>) {
  return updateUserById.mock.calls.find(
    ([, args]) => args && typeof args === 'object' && 'app_metadata' in args,
  )
}

function passwordSetCall(updateUserById: ReturnType<typeof vi.fn>) {
  return updateUserById.mock.calls.find(
    ([, args]) => args && typeof args === 'object' && 'password' in args,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/account/password', () => {
  it('returns 401 when unauthenticated', async () => {
    mockUserClient({ user: null })
    mockService({})

    const req = createMockRequest('/api/account/password', {
      method: 'POST',
      body: { password: STRONG_PASSWORD },
    })
    const { status } = await parseJsonResponse(await POST(req))
    expect(status).toBe(401)
  })

  it('returns 400 when password is too weak', async () => {
    mockUserClient({ user: { id: 'user-1', app_metadata: { has_password: true } } })
    mockService({ priorAppMetadata: { has_password: true } })

    const req = createMockRequest('/api/account/password', {
      method: 'POST',
      body: { password: 'weak' },
    })
    const { status } = await parseJsonResponse(await POST(req))
    expect(status).toBe(400)
  })

  describe('first-time set (no known password per userHasPassword)', () => {
    it('writes the password via admin API and flips the flag', async () => {
      const { updateUser } = mockUserClient({
        user: {
          id: 'user-1',
          app_metadata: { has_password: false, bankid_linked: true },
        },
      })
      const { updateUserById } = mockService({
        priorAppMetadata: { has_password: false, bankid_linked: true },
      })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD },
      })
      const { status, body } = await parseJsonResponse<{
        data?: { ok: boolean }
      }>(await POST(req))

      expect(status).toBe(200)
      expect(body.data?.ok).toBe(true)
      // Did NOT go through the user session: that path would fail with AAL2.
      expect(updateUser).not.toHaveBeenCalled()
      // Password set via admin
      expect(passwordSetCall(updateUserById)).toEqual([
        'user-1',
        { password: STRONG_PASSWORD },
      ])
      // Flag flipped, siblings preserved
      expect(flagFlipCall(updateUserById)).toEqual([
        'user-1',
        {
          app_metadata: {
            has_password: true,
            bankid_linked: true,
          },
        },
      ])
    })

    it('treats a BankID-linked user with no flag as first-time set', async () => {
      const { updateUser } = mockUserClient({
        user: { id: 'user-1', app_metadata: { bankid_linked: true } },
      })
      const { updateUserById } = mockService({ priorAppMetadata: { bankid_linked: true } })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD },
      })
      const { status } = await parseJsonResponse(await POST(req))

      expect(status).toBe(200)
      expect(updateUser).not.toHaveBeenCalled()
      expect(passwordSetCall(updateUserById)).toBeDefined()
    })

    it('returns 400 and skips flag flip when the admin password set fails', async () => {
      const { updateUser } = mockUserClient({
        user: { id: 'user-1', app_metadata: { has_password: false } },
      })
      const { updateUserById } = mockService({
        priorAppMetadata: { has_password: false },
        passwordSetError: { message: 'Password too weak', status: 400 },
      })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD },
      })
      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await POST(req),
      )

      expect(status).toBe(400)
      expect(body.error).toBe('Något gick fel. Försök igen.')
      expect(updateUser).not.toHaveBeenCalled()
      expect(flagFlipCall(updateUserById)).toBeUndefined()
    })

    it('still returns success when the flag flip fails after admin password set', async () => {
      mockUserClient({
        user: { id: 'user-1', app_metadata: { has_password: false } },
      })
      mockService({
        priorAppMetadata: { has_password: false },
        flagFlipError: new Error('admin down'),
      })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD },
      })
      const { status, body } = await parseJsonResponse<{
        data?: { ok: boolean }
      }>(await POST(req))

      expect(status).toBe(200)
      expect(body.data?.ok).toBe(true)
    })
  })

  describe('change-password (a known password per userHasPassword)', () => {
    // An email signup never gets the flag written at signup. It still chose
    // its password, so a change must go through the session's AAL2 guard,
    // never the admin API that skips it.
    it('treats an email signup with no flag as a password change', async () => {
      const { updateUser } = mockUserClient({
        user: { id: 'user-1' /* no app_metadata */ },
      })
      const { updateUserById } = mockService({})

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD },
      })
      const { status } = await parseJsonResponse(await POST(req))

      expect(status).toBe(200)
      expect(updateUser).toHaveBeenCalledWith({ password: STRONG_PASSWORD })
      expect(passwordSetCall(updateUserById)).toBeUndefined()
    })

    it('writes via the user session so Supabase enforces AAL2', async () => {
      const { updateUser } = mockUserClient({
        user: { id: 'user-1', app_metadata: { has_password: true } },
      })
      const { updateUserById } = mockService({
        priorAppMetadata: { has_password: true, provider: 'email' },
      })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD },
      })
      const { status, body } = await parseJsonResponse<{
        data?: { ok: boolean }
      }>(await POST(req))

      expect(status).toBe(200)
      expect(body.data?.ok).toBe(true)
      // Used user session, NOT admin API for the password itself
      expect(updateUser).toHaveBeenCalledWith({ password: STRONG_PASSWORD })
      expect(passwordSetCall(updateUserById)).toBeUndefined()
      // Flag is still flipped (idempotent) with siblings preserved
      expect(flagFlipCall(updateUserById)).toEqual([
        'user-1',
        {
          app_metadata: {
            has_password: true,
            provider: 'email',
          },
        },
      ])
    })

    it('returns 400 and skips flag flip when Supabase rejects the password update', async () => {
      const { updateUser } = mockUserClient({
        user: { id: 'user-1', app_metadata: { has_password: true } },
        updateUserError: { message: 'Password too similar to old', status: 400 },
      })
      const { updateUserById } = mockService({
        priorAppMetadata: { has_password: true },
      })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD },
      })
      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await POST(req),
      )

      expect(status).toBe(400)
      expect(body.error).toBe('Något gick fel. Försök igen.')
      expect(updateUser).toHaveBeenCalledWith({ password: STRONG_PASSWORD })
      expect(flagFlipCall(updateUserById)).toBeUndefined()
    })

    it('surfaces the AAL2 error verbatim so the client can step up via /mfa/verify', async () => {
      mockUserClient({
        user: { id: 'user-1', app_metadata: { has_password: true } },
        updateUserError: {
          message:
            'AAL2 session is required to update email or password when MFA is enabled',
          status: 422,
        },
      })
      mockService({ priorAppMetadata: { has_password: true } })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD },
      })
      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await POST(req),
      )

      expect(status).toBe(400)
      expect(body.error).toContain('AAL2')
    })
  })

  describe('other sessions end after a password change (CASA 2.2.2)', () => {
    it('revokes every other session after a change, keeping the current one', async () => {
      const { signOut } = mockUserClient({
        user: { id: 'user-1', app_metadata: { has_password: true } },
      })
      mockService({ priorAppMetadata: { has_password: true } })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD },
      })
      const { status, body } = await parseJsonResponse<{
        data?: { ok: boolean; otherSessionsEnded: boolean }
      }>(await POST(req))

      expect(status).toBe(200)
      expect(signOut).toHaveBeenCalledWith({ scope: 'others' })
      expect(body.data).toEqual({ ok: true, otherSessionsEnded: true, sessionKept: true })
    })

    it('also ends other sessions on a first-time set (the recovery and BankID paths)', async () => {
      const { signOut } = mockUserClient({
        user: { id: 'user-1', app_metadata: { has_password: false, bankid_linked: true } },
      })
      mockService({ priorAppMetadata: { has_password: false, bankid_linked: true } })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD },
      })
      const { status } = await parseJsonResponse(await POST(req))

      expect(status).toBe(200)
      expect(signOut).toHaveBeenCalledWith({ scope: 'others' })
    })

    it('does not touch sessions when the change itself failed', async () => {
      const { signOut } = mockUserClient({
        user: { id: 'user-1', app_metadata: { has_password: true } },
        updateUserError: { message: 'Password too similar to old', status: 400 },
      })
      mockService({ priorAppMetadata: { has_password: true } })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD },
      })
      await POST(req)

      expect(signOut).not.toHaveBeenCalled()
    })

    it('keeps the new password and reports it when the revocation fails', async () => {
      mockUserClient({
        user: { id: 'user-1', app_metadata: { has_password: true } },
        signOutError: { message: 'upstream down', status: 500 },
      })
      mockService({ priorAppMetadata: { has_password: true } })

      const req = createMockRequest('/api/account/password', {
        method: 'POST',
        body: { password: STRONG_PASSWORD },
      })
      const { status, body } = await parseJsonResponse<{
        data?: { ok: boolean; otherSessionsEnded: boolean }
      }>(await POST(req))

      expect(status).toBe(200)
      expect(body.data).toEqual({ ok: true, otherSessionsEnded: false, sessionKept: true })
    })
  })

  // The admin password write ends every session of the user, the one making
  // the request included: 13 BankID users in two weeks were bounced to /login
  // seconds after choosing their first password.
  describe('the session after a first-time set', () => {
    const bankIdUser = { id: 'user-1', app_metadata: { has_password: false, bankid_linked: true } }

    function post() {
      return POST(createMockRequest('/api/account/password', { method: 'POST', body: { password: STRONG_PASSWORD } }))
    }

    it('is replaced by a new one, minted for the user and written on this request', async () => {
      const { verifyOtp, signOut } = mockUserClient({ user: bankIdUser })
      const { generateLink, updateUserById } = mockService({
        priorAppMetadata: bankIdUser.app_metadata,
        currentEmail: 'anna@example.com',
      })

      const { status, body } = await parseJsonResponse<{
        data?: { ok: boolean; otherSessionsEnded: boolean; sessionKept: boolean }
      }>(await post())

      expect(status).toBe(200)
      expect(generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'anna@example.com' })
      expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'hashed-token-1', type: 'magiclink' })
      expect(body.data).toEqual({ ok: true, otherSessionsEnded: true, sessionKept: true })
      // After the flag write, so the new token already says has_password; and
      // the other sessions are ended with the session that exists now.
      const flagWrite = updateUserById.mock.invocationCallOrder.at(-1)!
      expect(generateLink.mock.invocationCallOrder[0]).toBeGreaterThan(flagWrite)
      expect(signOut.mock.invocationCallOrder[0]).toBeGreaterThan(verifyOtp.mock.invocationCallOrder[0])
    })

    it('is not touched by a password change: that session survives the write', async () => {
      const { verifyOtp } = mockUserClient({ user: { id: 'user-1', app_metadata: { has_password: true } } })
      const { generateLink } = mockService({ priorAppMetadata: { has_password: true } })

      await post()

      expect(generateLink).not.toHaveBeenCalled()
      expect(verifyOtp).not.toHaveBeenCalled()
    })

    it('is reported as lost when the link cannot be minted, and the password stands', async () => {
      const { verifyOtp, signOut } = mockUserClient({ user: bankIdUser })
      mockService({
        priorAppMetadata: bankIdUser.app_metadata,
        generateLinkError: { message: 'upstream down', status: 500 },
      })

      const { status, body } = await parseJsonResponse<{
        data?: { ok: boolean; otherSessionsEnded: boolean; sessionKept: boolean }
      }>(await post())

      expect(status).toBe(200)
      expect(body.data).toEqual({ ok: true, otherSessionsEnded: false, sessionKept: false })
      expect(verifyOtp).not.toHaveBeenCalled()
      // No session to call GoTrue's logout with.
      expect(signOut).not.toHaveBeenCalled()
    })

    it('is reported as lost when the link is refused', async () => {
      mockUserClient({ user: bankIdUser, verifyOtpError: { message: 'expired', status: 403, code: 'otp_expired' } })
      mockService({ priorAppMetadata: bankIdUser.app_metadata })

      const { body } = await parseJsonResponse<{ data?: { sessionKept: boolean } }>(await post())

      expect(body.data?.sessionKept).toBe(false)
    })

    it('is reported as lost for a user with no e-mail address, without asking for a link', async () => {
      mockUserClient({ user: bankIdUser })
      const { generateLink } = mockService({ priorAppMetadata: bankIdUser.app_metadata, currentEmail: null })

      const { body } = await parseJsonResponse<{ data?: { sessionKept: boolean } }>(await post())

      expect(body.data?.sessionKept).toBe(false)
      expect(generateLink).not.toHaveBeenCalled()
    })

    it('is never minted for the address in the token, only for the one the auth server holds', async () => {
      mockUserClient({ user: bankIdUser })
      const { generateLink } = mockService({
        priorAppMetadata: bankIdUser.app_metadata,
        currentEmail: 'changed-an-hour-ago@example.com',
      })

      await post()

      expect(generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'changed-an-hour-ago@example.com' })
    })

    it('is not taken from a link that came back for another user', async () => {
      const { verifyOtp } = mockUserClient({ user: bankIdUser })
      mockService({ priorAppMetadata: bankIdUser.app_metadata, linkUserId: 'someone-else' })

      const { body } = await parseJsonResponse<{ data?: { sessionKept: boolean } }>(await post())

      expect(body.data?.sessionKept).toBe(false)
      expect(verifyOtp).not.toHaveBeenCalled()
    })
  })
})
