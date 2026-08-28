import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

import { POST } from '../route'

function mockUserClient(opts: {
  user: { id: string; email?: string } | null
  updateUserError?: { message: string; status?: number; code?: string } | null
}) {
  const updateUser = vi.fn().mockResolvedValue({
    data: {},
    error: opts.updateUserError ?? null,
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = { auth: { updateUser } } as any

  if (opts.user) {
    requireAuthMock.mockResolvedValue({ user: opts.user, supabase, error: null })
  } else {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
  }

  return { updateUser }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/account/email', () => {
  it('returns 401 when unauthenticated', async () => {
    mockUserClient({ user: null })

    const req = createMockRequest('/api/account/email', {
      method: 'POST',
      body: { email: 'new@testbrand.example' },
    })
    const { status } = await parseJsonResponse(await POST(req))
    expect(status).toBe(401)
  })

  it('returns 400 for an invalid email', async () => {
    const { updateUser } = mockUserClient({
      user: { id: 'user-1', email: 'old@testbrand.example' },
    })

    const req = createMockRequest('/api/account/email', {
      method: 'POST',
      body: { email: 'not-an-email' },
    })
    const { status } = await parseJsonResponse(await POST(req))
    expect(status).toBe(400)
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('returns 400 when the new email equals the current one (case-insensitive)', async () => {
    const { updateUser } = mockUserClient({
      user: { id: 'user-1', email: 'Old@Testbrand.example' },
    })

    const req = createMockRequest('/api/account/email', {
      method: 'POST',
      body: { email: 'old@testbrand.example' },
    })
    const { status, body } = await parseJsonResponse<{ error?: string }>(
      await POST(req),
    )
    expect(status).toBe(400)
    expect(body.error).toBe('Det är redan din e-postadress.')
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('requests the change via the user session with a callback redirect', async () => {
    const { updateUser } = mockUserClient({
      user: { id: 'user-1', email: 'old@testbrand.example' },
    })

    const req = createMockRequest('/api/account/email', {
      method: 'POST',
      body: { email: 'New@Testbrand.example' },
    })
    const { status, body } = await parseJsonResponse<{
      data?: { ok: boolean; pending_email: string }
    }>(await POST(req))

    expect(status).toBe(200)
    expect(body.data?.ok).toBe(true)
    // Normalized to lowercase before it reaches Supabase.
    expect(body.data?.pending_email).toBe('new@testbrand.example')
    expect(updateUser).toHaveBeenCalledTimes(1)
    const [attrs, options] = updateUser.mock.calls[0]
    expect(attrs).toEqual({ email: 'new@testbrand.example' })
    expect(String(options.emailRedirectTo)).toMatch(/\/auth\/callback$/)
  })

  it('returns 400 and surfaces the AAL2 error when Supabase rejects the update', async () => {
    const { updateUser } = mockUserClient({
      user: { id: 'user-1', email: 'old@testbrand.example' },
      updateUserError: {
        message:
          'AAL2 session is required to update email or password when MFA is enabled',
        status: 422,
      },
    })

    const req = createMockRequest('/api/account/email', {
      method: 'POST',
      body: { email: 'new@testbrand.example' },
    })
    const { status, body } = await parseJsonResponse<{ error?: string }>(
      await POST(req),
    )

    expect(status).toBe(400)
    expect(updateUser).toHaveBeenCalled()
    expect(body.error).toContain('AAL2')
  })
})
