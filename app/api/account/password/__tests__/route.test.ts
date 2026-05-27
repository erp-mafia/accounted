import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { POST } from '../route'

const mockCreateClient = vi.mocked(createClient)
const mockCreateServiceClient = vi.mocked(createServiceClient)

type AuthMetadata = Record<string, unknown>

function mockUserClient(opts: {
  user: { id: string; app_metadata?: AuthMetadata } | null
  updateUserError?: { message: string; status?: number; code?: string } | null
}) {
  const updateUser = vi.fn().mockResolvedValue({
    data: {},
    error: opts.updateUserError ?? null,
  })

  mockCreateClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: opts.user } }),
      updateUser,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  return { updateUser }
}

function mockService(opts: {
  priorAppMetadata?: AuthMetadata
  // Returned-error from admin.updateUserById when called with { password }
  passwordSetError?: { message: string; status?: number; code?: string } | null
  // Thrown error from admin.updateUserById when called with { app_metadata }
  flagFlipError?: Error | null
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

  const getUserById = vi.fn().mockResolvedValue({
    data: { user: { app_metadata: opts.priorAppMetadata ?? {} } },
  })

  mockCreateServiceClient.mockReturnValue({
    auth: { admin: { getUserById, updateUserById } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  return { getUserById, updateUserById }
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

  describe('first-time set (has_password !== true)', () => {
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
      // Did NOT go through the user session — that path would fail with AAL2.
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

    it('treats unset has_password as first-time set', async () => {
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
      expect(body.error).toContain('Password too weak')
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

  describe('change-password (has_password === true)', () => {
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
      expect(body.error).toContain('Password too similar')
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
})
