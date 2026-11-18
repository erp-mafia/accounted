import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

// The pauses between the attempts to end the other sessions: no real waiting.
vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  sleep: vi.fn().mockResolvedValue(undefined),
}))

import { createServiceClient } from '@/lib/supabase/server'
import { sleep } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { passwordSavedDespiteFailure } from '@/lib/auth/password-change-result'
import { POST } from '../route'

const mockCreateServiceClient = vi.mocked(createServiceClient)
const mockSleep = vi.mocked(sleep)

type AuthMetadata = Record<string, unknown>
type AuthErr = { message: string; status?: number; code?: string }

// The access token in the request's cookie, and the one of the session a
// first-time set mints: the logout of the other sessions must be asked as
// whichever session the user holds when the route gets there.
const REQUEST_TOKEN = 'access-token-of-the-request'
const RESTORED_TOKEN = 'access-token-of-the-restored-session'

function mockUserClient(opts: {
  user: { id: string; app_metadata?: AuthMetadata } | null
  updateUserError?: AuthErr | null
  // What GoTrue's logout with scope others answers, attempt by attempt: an
  // error it returns, an Error the call throws, or null for "done". Attempts
  // past the end of the list succeed. Default: the first attempt succeeds.
  logoutOthers?: Array<AuthErr | Error | null>
  // No session in the cookie store when the route asks for the token.
  noSession?: boolean
  // Returned-error from verifyOtp on the link that restores the session.
  verifyOtpError?: AuthErr | null
}) {
  let accessToken = REQUEST_TOKEN
  const updateUser = vi.fn().mockResolvedValue({
    data: {},
    error: opts.updateUserError ?? null,
  })
  // auth.signOut() is the wrapper the route must NOT confirm with: it answers
  // "no error" for a missing session and for a 401, 403 or 404 from GoTrue.
  const signOut = vi.fn().mockResolvedValue({ error: null })
  const getSession = vi.fn().mockImplementation(() =>
    Promise.resolve({ data: { session: opts.noSession ? null : { access_token: accessToken } }, error: null }),
  )
  const answers = [...(opts.logoutOthers ?? [])]
  const logoutOthers = vi.fn().mockImplementation(() => {
    const answer = answers.shift() ?? null
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve({ data: null, error: answer })
  })
  const verifyOtp = vi.fn().mockImplementation(() => {
    if (opts.verifyOtpError) {
      return Promise.resolve({ data: { session: null, user: null }, error: opts.verifyOtpError })
    }
    accessToken = RESTORED_TOKEN
    return Promise.resolve({
      data: { session: { access_token: RESTORED_TOKEN }, user: { id: opts.user?.id } },
      error: null,
    })
  })

  const supabase = {
    auth: { updateUser, signOut, getSession, verifyOtp, admin: { signOut: logoutOthers } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any

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

  return { updateUser, signOut, getSession, logoutOthers, verifyOtp }
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
    const passwordUser = { id: 'user-1', app_metadata: { has_password: true } }
    const bankIdUser = { id: 'user-1', app_metadata: { has_password: false, bankid_linked: true } }
    const UNCONFIRMED = 'PASSWORD_CHANGED_REVOCATION_UNCONFIRMED'
    const upstreamDown: AuthErr = { message: 'upstream down', status: 502 }

    type Failure = {
      data?: unknown
      error?: {
        code: string
        message: string
        message_en: string
        details?: { passwordChanged: boolean; otherSessionsEnded: boolean; sessionKept: boolean }
      }
    }

    function post() {
      return POST(createMockRequest('/api/account/password', { method: 'POST', body: { password: STRONG_PASSWORD } }))
    }

    // The logger writes its error records to console.error, in tests too.
    let errorLog: MockInstance<typeof console.error>
    beforeEach(() => {
      errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    })
    afterEach(() => {
      errorLog.mockRestore()
    })
    const loggedAtErrorLevel = (text: string) =>
      errorLog.mock.calls.some((args) => args.some((arg: unknown) => typeof arg === 'string' && arg.includes(text)))

    it('ends every other session after a change, asked as the session that made the request', async () => {
      const { logoutOthers } = mockUserClient({ user: passwordUser })
      mockService({ priorAppMetadata: { has_password: true } })

      const { status, body } = await parseJsonResponse<{
        data?: { ok: boolean; otherSessionsEnded: boolean }
      }>(await post())

      expect(status).toBe(200)
      expect(logoutOthers).toHaveBeenCalledTimes(1)
      expect(logoutOthers).toHaveBeenCalledWith(REQUEST_TOKEN, 'others')
      expect(mockSleep).not.toHaveBeenCalled()
      expect(body.data).toEqual({ ok: true, otherSessionsEnded: true, sessionKept: true })
    })

    it('also ends other sessions on a first-time set (the recovery and BankID paths), asked as the restored session', async () => {
      const { logoutOthers } = mockUserClient({ user: bankIdUser })
      mockService({ priorAppMetadata: bankIdUser.app_metadata })

      const { status } = await parseJsonResponse(await post())

      expect(status).toBe(200)
      expect(logoutOthers).toHaveBeenCalledWith(RESTORED_TOKEN, 'others')
    })

    it('does not touch sessions when the change itself failed', async () => {
      const { logoutOthers, getSession } = mockUserClient({
        user: passwordUser,
        updateUserError: { message: 'Password too similar to old', status: 400 },
      })
      mockService({ priorAppMetadata: { has_password: true } })

      await post()

      expect(getSession).not.toHaveBeenCalled()
      expect(logoutOthers).not.toHaveBeenCalled()
    })

    it('answers ok when the first attempt fails and the second is confirmed', async () => {
      const { logoutOthers } = mockUserClient({ user: passwordUser, logoutOthers: [upstreamDown] })
      mockService({ priorAppMetadata: { has_password: true } })

      const { status, body } = await parseJsonResponse<{
        data?: { ok: boolean; otherSessionsEnded: boolean; sessionKept: boolean }
      }>(await post())

      expect(status).toBe(200)
      expect(body.data).toEqual({ ok: true, otherSessionsEnded: true, sessionKept: true })
      expect(logoutOthers).toHaveBeenCalledTimes(2)
      expect(mockSleep.mock.calls).toEqual([[150]])
      expect(loggedAtErrorLevel(UNCONFIRMED)).toBe(false)
    })

    it('answers ok when only the third attempt is confirmed, after 150 ms and 500 ms', async () => {
      const { logoutOthers } = mockUserClient({
        user: passwordUser,
        logoutOthers: [upstreamDown, new Error('socket hang up')],
      })
      mockService({ priorAppMetadata: { has_password: true } })

      const { status, body } = await parseJsonResponse<{ data?: { otherSessionsEnded: boolean } }>(await post())

      expect(status).toBe(200)
      expect(body.data?.otherSessionsEnded).toBe(true)
      expect(logoutOthers).toHaveBeenCalledTimes(3)
      expect(mockSleep.mock.calls).toEqual([[150], [500]])
    })

    it('never answers ok while the other sessions are unconfirmed: three attempts, then an error that says the password is saved', async () => {
      const { logoutOthers } = mockUserClient({
        user: passwordUser,
        logoutOthers: [upstreamDown, upstreamDown, upstreamDown],
      })
      const { updateUserById } = mockService({ priorAppMetadata: { has_password: true } })

      const { status, body } = await parseJsonResponse<Failure>(await post())

      expect(status).toBe(500)
      expect(body.data).toBeUndefined()
      expect(body.error?.code).toBe(UNCONFIRMED)
      expect(body.error?.details).toEqual({ passwordChanged: true, otherSessionsEnded: false, sessionKept: true })
      // Three attempts, 150 ms and 500 ms apart, and no fourth.
      expect(logoutOthers).toHaveBeenCalledTimes(3)
      expect(mockSleep.mock.calls).toEqual([[150], [500]])
      expect(loggedAtErrorLevel(UNCONFIRMED)).toBe(true)
      // The password stands, and so does its flag: nothing is rolled back.
      expect(flagFlipCall(updateUserById)).toBeDefined()
    })

    it('says so in Swedish and in English through the error mapping, and tells a client the password is saved', async () => {
      mockUserClient({ user: passwordUser, logoutOthers: [upstreamDown, upstreamDown, upstreamDown] })
      mockService({ priorAppMetadata: { has_password: true } })

      const { body } = await parseJsonResponse<Failure>(await post())

      const entry = getErrorEntry(UNCONFIRMED)!
      expect(body.error?.message).toBe(entry.message_sv)
      expect(body.error?.message_en).toBe(entry.message_en)
      const swedish = getErrorMessage(body, { locale: 'sv', fallback: 'Kunde inte spara lösenordet. Försök igen.' })
      expect(swedish).toContain('Lösenordet är sparat')
      expect(swedish).toContain('kunde inte bekräfta att dina andra enheter loggades ut')
      expect(swedish).toContain('Logga ut från alla enheter')
      expect(swedish).not.toMatch(/försök igen/i)
      expect(getErrorMessage(body, { locale: 'en' })).toBe(entry.message_en)
      expect(entry.retryable).toBe(false)
      expect(passwordSavedDespiteFailure(body)).toBe(true)
    })

    it('counts a call that throws as unconfirmed', async () => {
      const boom = new Error('socket hang up')
      const { logoutOthers } = mockUserClient({ user: passwordUser, logoutOthers: [boom, boom, boom] })
      mockService({ priorAppMetadata: { has_password: true } })

      const { status, body } = await parseJsonResponse<Failure>(await post())

      expect(status).toBe(500)
      expect(body.error?.code).toBe(UNCONFIRMED)
      expect(logoutOthers).toHaveBeenCalledTimes(3)
    })

    // auth.signOut({ scope: 'others' }) answers "no error" for these two, so
    // the route asks GoTrue's logout itself and never takes the wrapper's word.
    it('is unconfirmed when GoTrue no longer knows the session it is asked as', async () => {
      const gone: AuthErr = { message: 'Session from session_id claim in JWT does not exist', status: 403, code: 'session_not_found' }
      const { signOut } = mockUserClient({ user: passwordUser, logoutOthers: [gone, gone, gone] })
      mockService({ priorAppMetadata: { has_password: true } })

      const { status, body } = await parseJsonResponse<Failure>(await post())

      expect(status).toBe(500)
      expect(body.error?.code).toBe(UNCONFIRMED)
      expect(signOut).not.toHaveBeenCalled()
    })

    it('is unconfirmed when there is no session to ask with', async () => {
      const { logoutOthers, signOut } = mockUserClient({ user: passwordUser, noSession: true })
      mockService({ priorAppMetadata: { has_password: true } })

      const { status, body } = await parseJsonResponse<Failure>(await post())

      expect(status).toBe(500)
      expect(body.error?.code).toBe(UNCONFIRMED)
      expect(logoutOthers).not.toHaveBeenCalled()
      expect(signOut).not.toHaveBeenCalled()
    })

    it('is an error on a first-time set too, when the restored session cannot confirm it', async () => {
      mockUserClient({ user: bankIdUser, logoutOthers: [upstreamDown, upstreamDown, upstreamDown] })
      mockService({ priorAppMetadata: bankIdUser.app_metadata })

      const { status, body } = await parseJsonResponse<Failure>(await post())

      expect(status).toBe(500)
      expect(body.data).toBeUndefined()
      expect(body.error?.code).toBe(UNCONFIRMED)
      expect(body.error?.details).toEqual({ passwordChanged: true, otherSessionsEnded: false, sessionKept: true })
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
      const { verifyOtp, logoutOthers } = mockUserClient({ user: bankIdUser })
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
      expect(logoutOthers.mock.invocationCallOrder[0]).toBeGreaterThan(verifyOtp.mock.invocationCallOrder[0])
    })

    it('is not touched by a password change: that session survives the write', async () => {
      const { verifyOtp } = mockUserClient({ user: { id: 'user-1', app_metadata: { has_password: true } } })
      const { generateLink } = mockService({ priorAppMetadata: { has_password: true } })

      await post()

      expect(generateLink).not.toHaveBeenCalled()
      expect(verifyOtp).not.toHaveBeenCalled()
    })

    it('is reported as lost when the link cannot be minted, and the password stands', async () => {
      const { verifyOtp, getSession, logoutOthers } = mockUserClient({ user: bankIdUser })
      mockService({
        priorAppMetadata: bankIdUser.app_metadata,
        generateLinkError: { message: 'upstream down', status: 500 },
      })

      const { status, body } = await parseJsonResponse<{
        data?: { ok: boolean; otherSessionsEnded: boolean; sessionKept: boolean }
      }>(await post())

      expect(status).toBe(200)
      // The truth about the other sessions: the admin write ended every
      // session the user had, this request's with them. Nothing is left to
      // end, and there is no session to ask GoTrue's logout with.
      expect(body.data).toEqual({ ok: true, otherSessionsEnded: true, sessionKept: false })
      expect(verifyOtp).not.toHaveBeenCalled()
      expect(getSession).not.toHaveBeenCalled()
      expect(logoutOthers).not.toHaveBeenCalled()
    })

    it('is reported as lost when the link is refused', async () => {
      const { logoutOthers } = mockUserClient({
        user: bankIdUser,
        verifyOtpError: { message: 'expired', status: 403, code: 'otp_expired' },
      })
      mockService({ priorAppMetadata: bankIdUser.app_metadata })

      const { status, body } = await parseJsonResponse<{
        data?: { ok: boolean; otherSessionsEnded: boolean; sessionKept: boolean }
      }>(await post())

      expect(status).toBe(200)
      expect(body.data).toEqual({ ok: true, otherSessionsEnded: true, sessionKept: false })
      expect(logoutOthers).not.toHaveBeenCalled()
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
