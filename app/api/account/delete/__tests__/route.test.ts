import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { POST } from '../route'

const mockCreateClient = vi.mocked(createClient)
const mockCreateServiceClient = vi.mocked(createServiceClient)

function mockAuth(
  user: { id: string; email: string | null } | null,
  rpcResult: { data?: unknown; error?: unknown } = { data: null, error: null }
) {
  const signOut = vi.fn().mockResolvedValue({ error: null })
  const rpc = vi.fn().mockResolvedValue(rpcResult)

  mockCreateClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
      signOut,
    },
    rpc,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  return { rpc, signOut }
}

function mockServiceClient(blockers: { id: string; name: string }[] = []) {
  const updateUserById = vi.fn().mockResolvedValue({ data: {}, error: null })
  const adminSignOut = vi.fn().mockResolvedValue({ data: null, error: null })

  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockResolvedValue({
      data: blockers.map((b) => ({ companies: { id: b.id, name: b.name } })),
      error: null,
    }),
  }

  mockCreateServiceClient.mockReturnValue({
    from: vi.fn().mockReturnValue(chain),
    auth: {
      admin: {
        updateUserById,
        signOut: adminSignOut,
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  return { updateUserById, adminSignOut }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('POST /api/account/delete', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuth(null)

    const req = createMockRequest('/api/account/delete', {
      method: 'POST',
      body: { confirm_email: 'u@example.com' },
    })
    const { status } = await parseJsonResponse(await POST(req))
    expect(status).toBe(401)
  })

  it('returns 400 when confirm_email does not match', async () => {
    mockAuth({ id: 'user-1', email: 'right@example.com' })

    const req = createMockRequest('/api/account/delete', {
      method: 'POST',
      body: { confirm_email: 'wrong@example.com' },
    })
    const { status, body } = await parseJsonResponse(await POST(req))
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })

  it('returns 409 with blockers when RPC raises P0001', async () => {
    mockAuth(
      { id: 'user-1', email: 'u@example.com' },
      { data: null, error: { code: 'P0001', message: 'blocked' } }
    )
    mockServiceClient([{ id: 'c1', name: 'Acme AB' }])

    const req = createMockRequest('/api/account/delete', {
      method: 'POST',
      body: { confirm_email: 'u@example.com' },
    })
    const { status, body } = await parseJsonResponse<{
      error: string
      blockers: { id: string; name: string }[]
    }>(await POST(req))

    expect(status).toBe(409)
    expect(body.blockers).toEqual([{ id: 'c1', name: 'Acme AB' }])
  })

  it('anonymizes, bans, signs out, and emits event on happy path', async () => {
    const { rpc } = mockAuth({ id: 'user-1', email: 'u@example.com' })
    const { updateUserById, adminSignOut } = mockServiceClient()

    const emitted: unknown[] = []
    eventBus.on('account.deleted', (payload) => {
      emitted.push(payload)
    })

    const req = createMockRequest('/api/account/delete', {
      method: 'POST',
      body: { confirm_email: 'u@example.com' },
    })
    const { status, body } = await parseJsonResponse<{ success: boolean }>(
      await POST(req)
    )

    expect(status).toBe(200)
    expect(body.success).toBe(true)

    expect(rpc).toHaveBeenCalledWith('anonymize_user_account', {
      target_user_id: 'user-1',
    })
    expect(updateUserById).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        user_metadata: {},
        app_metadata: {},
        ban_duration: expect.any(String),
      })
    )
    // Email must NOT be scrubbed: retaining it is what blocks re-signup
    // with the same address. Recovery goes through support instead.
    const updatePayload = updateUserById.mock.calls[0][1]
    expect(updatePayload).not.toHaveProperty('email')
    expect(adminSignOut).toHaveBeenCalledWith('user-1', 'global')
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ userId: 'user-1' })
  })
})
