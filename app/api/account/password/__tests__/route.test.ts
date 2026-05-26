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

function mockUserClient(opts: {
  user: { id: string } | null
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
  priorAppMetadata?: Record<string, unknown>
  updateUserByIdError?: Error | null
}) {
  const updateUserById = opts.updateUserByIdError
    ? vi.fn().mockRejectedValue(opts.updateUserByIdError)
    : vi.fn().mockResolvedValue({ data: {}, error: null })

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
    mockUserClient({ user: { id: 'user-1' } })
    mockService({})

    const req = createMockRequest('/api/account/password', {
      method: 'POST',
      body: { password: 'weak' },
    })
    const { status } = await parseJsonResponse(await POST(req))
    expect(status).toBe(400)
  })

  it('returns 400 when Supabase rejects the password update', async () => {
    const { updateUser } = mockUserClient({
      user: { id: 'user-1' },
      updateUserError: { message: 'Password too similar to old', status: 400 },
    })
    const { updateUserById } = mockService({})

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
    // Flag should NOT be flipped on a failed password update
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it('flips app_metadata.has_password to true on success and preserves siblings', async () => {
    const { updateUser } = mockUserClient({ user: { id: 'user-1' } })
    const { getUserById, updateUserById } = mockService({
      priorAppMetadata: { bankid_linked: true, provider: 'email' },
    })

    const req = createMockRequest('/api/account/password', {
      method: 'POST',
      body: { password: STRONG_PASSWORD },
    })
    const { status, body } = await parseJsonResponse<{ data?: { ok: boolean } }>(
      await POST(req),
    )
    expect(status).toBe(200)
    expect(body.data?.ok).toBe(true)
    expect(updateUser).toHaveBeenCalledWith({ password: STRONG_PASSWORD })
    expect(getUserById).toHaveBeenCalledWith('user-1')
    expect(updateUserById).toHaveBeenCalledWith('user-1', {
      app_metadata: {
        bankid_linked: true,
        provider: 'email',
        has_password: true,
      },
    })
  })

  it('still returns success when the flag flip fails (password is set; logged)', async () => {
    mockUserClient({ user: { id: 'user-1' } })
    mockService({ updateUserByIdError: new Error('admin down') })

    const req = createMockRequest('/api/account/password', {
      method: 'POST',
      body: { password: STRONG_PASSWORD },
    })
    const { status, body } = await parseJsonResponse<{ data?: { ok: boolean } }>(
      await POST(req),
    )
    expect(status).toBe(200)
    expect(body.data?.ok).toBe(true)
  })
})
