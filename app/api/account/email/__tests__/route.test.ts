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
  // What GoTrue returns for the fresh user (the pending-change fields the
  // claims fast path lacks). Defaults to "no pending change".
  freshUser?: {
    new_email?: string
    email_change_sent_at?: string
  } | null
  // Outcome of claim_email_change_request: true (won, default), false
  // (another request holds the claim), or an error object (RPC failed).
  claim?: boolean | { message: string; code?: string }
}) {
  const updateUser = vi.fn().mockResolvedValue({
    data: {},
    error: opts.updateUserError ?? null,
  })
  const rpc = vi.fn().mockImplementation(async (name: string) => {
    if (name === 'claim_email_change_request') {
      const claim = opts.claim ?? true
      return typeof claim === 'boolean'
        ? { data: claim, error: null }
        : { data: null, error: claim }
    }
    return { data: null, error: null }
  })
  const getUser = vi.fn().mockResolvedValue({
    data: {
      user:
        opts.freshUser === null
          ? null
          : { id: opts.user?.id, email: opts.user?.email, ...(opts.freshUser ?? {}) },
    },
    error: null,
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = { auth: { updateUser, getUser }, rpc } as any

  if (opts.user) {
    requireAuthMock.mockResolvedValue({ user: opts.user, supabase, error: null })
  } else {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
  }

  return { updateUser, getUser, rpc }
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
    // flow=email_change routes the stock GoTrue redirect (message/error/code)
    // to the email-change status page in /auth/callback.
    expect(String(options.emailRedirectTo)).toMatch(
      /\/auth\/callback\?flow=email_change$/,
    )
  })

  it('short-circuits a repeat request while the pending mails are fresh', async () => {
    const { updateUser } = mockUserClient({
      user: {
        id: 'user-1',
        email: 'old@testbrand.example',
        new_email: 'pending@testbrand.example',
        email_change_sent_at: new Date(Date.now() - 60_000).toISOString(),
      } as { id: string; email?: string },
    })

    const req = createMockRequest('/api/account/email', {
      method: 'POST',
      body: { email: 'Pending@Testbrand.example' },
    })
    const { status, body } = await parseJsonResponse<{
      data?: { ok: boolean; pending_email: string }
    }>(await POST(req))

    expect(status).toBe(200)
    expect(body.data?.pending_email).toBe('pending@testbrand.example')
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('re-sends when the pending change is stale (expired-link recovery)', async () => {
    const { updateUser } = mockUserClient({
      user: {
        id: 'user-1',
        email: 'old@testbrand.example',
        new_email: 'pending@testbrand.example',
        email_change_sent_at: new Date(
          Date.now() - 2 * 60 * 60 * 1000,
        ).toISOString(),
      } as { id: string; email?: string },
    })

    const req = createMockRequest('/api/account/email', {
      method: 'POST',
      body: { email: 'pending@testbrand.example' },
    })
    const { status } = await parseJsonResponse(await POST(req))

    expect(status).toBe(200)
    expect(updateUser).toHaveBeenCalledTimes(1)
  })

  it('re-sends when the pending change has no sent timestamp', async () => {
    const { updateUser } = mockUserClient({
      user: {
        id: 'user-1',
        email: 'old@testbrand.example',
        new_email: 'pending@testbrand.example',
      } as { id: string; email?: string },
    })

    const req = createMockRequest('/api/account/email', {
      method: 'POST',
      body: { email: 'pending@testbrand.example' },
    })
    const { status } = await parseJsonResponse(await POST(req))

    expect(status).toBe(200)
    expect(updateUser).toHaveBeenCalledTimes(1)
  })

  it('reads pending state from GoTrue when the session claims lack it (fresh: no-op)', async () => {
    // The claims fast path carries no new_email; before this the route
    // re-issued tokens on every re-submit and voided the mails just sent.
    const { updateUser, getUser } = mockUserClient({
      user: { id: 'user-1', email: 'old@testbrand.example' },
      freshUser: {
        new_email: 'pending@testbrand.example',
        email_change_sent_at: new Date(Date.now() - 3 * 60_000).toISOString(),
      },
    })

    const req = createMockRequest('/api/account/email', {
      method: 'POST',
      body: { email: 'pending@testbrand.example' },
    })
    const { status, body } = await parseJsonResponse<{
      data?: { ok: boolean; pending_email: string; resent: boolean }
    }>(await POST(req))

    expect(status).toBe(200)
    expect(body.data?.resent).toBe(false)
    expect(getUser).toHaveBeenCalledTimes(1)
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('reads pending state from GoTrue when the session claims lack it (stale: re-send)', async () => {
    const { updateUser } = mockUserClient({
      user: { id: 'user-1', email: 'old@testbrand.example' },
      freshUser: {
        new_email: 'pending@testbrand.example',
        email_change_sent_at: new Date(
          Date.now() - 2 * 60 * 60 * 1000,
        ).toISOString(),
      },
    })

    const req = createMockRequest('/api/account/email', {
      method: 'POST',
      body: { email: 'pending@testbrand.example' },
    })
    const { status, body } = await parseJsonResponse<{
      data?: { resent: boolean }
    }>(await POST(req))

    expect(status).toBe(200)
    expect(body.data?.resent).toBe(true)
    expect(updateUser).toHaveBeenCalledTimes(1)
  })

  it('requests a different address even while another change is pending and fresh', async () => {
    const { updateUser } = mockUserClient({
      user: { id: 'user-1', email: 'old@testbrand.example' },
      freshUser: {
        new_email: 'pending@testbrand.example',
        email_change_sent_at: new Date(Date.now() - 60_000).toISOString(),
      },
    })

    const req = createMockRequest('/api/account/email', {
      method: 'POST',
      body: { email: 'other@testbrand.example' },
    })
    const { status } = await parseJsonResponse(await POST(req))

    expect(status).toBe(200)
    expect(updateUser).toHaveBeenCalledTimes(1)
    expect(updateUser.mock.calls[0][0]).toEqual({ email: 'other@testbrand.example' })
  })

  it('does not consult GoTrue when the claims already carry the pending change', async () => {
    const { updateUser, getUser } = mockUserClient({
      user: {
        id: 'user-1',
        email: 'old@testbrand.example',
        new_email: 'pending@testbrand.example',
        email_change_sent_at: new Date(Date.now() - 60_000).toISOString(),
      } as { id: string; email?: string },
    })

    const req = createMockRequest('/api/account/email', {
      method: 'POST',
      body: { email: 'pending@testbrand.example' },
    })
    const { status } = await parseJsonResponse(await POST(req))

    expect(status).toBe(200)
    expect(getUser).not.toHaveBeenCalled()
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('claims the address atomically before calling GoTrue', async () => {
    const { updateUser, rpc } = mockUserClient({
      user: { id: 'user-1', email: 'old@testbrand.example' },
    })

    const req = createMockRequest('/api/account/email', {
      method: 'POST',
      body: { email: 'new@testbrand.example' },
    })
    const { status } = await parseJsonResponse(await POST(req))

    expect(status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('claim_email_change_request', {
      p_email: 'new@testbrand.example',
      p_window_seconds: 30 * 60,
    })
    // Claim strictly before the GoTrue call.
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(
      updateUser.mock.invocationCallOrder[0],
    )
    expect(rpc).not.toHaveBeenCalledWith('release_email_change_request')
  })

  it('answers already-pending without calling GoTrue when a concurrent request holds the claim', async () => {
    // Both requests read "nothing pending" from GoTrue; only the claim
    // winner may re-issue the tokens.
    const { updateUser } = mockUserClient({
      user: { id: 'user-1', email: 'old@testbrand.example' },
      claim: false,
    })

    const req = createMockRequest('/api/account/email', {
      method: 'POST',
      body: { email: 'new@testbrand.example' },
    })
    const { status, body } = await parseJsonResponse<{
      data?: { ok: boolean; pending_email: string; resent: boolean }
    }>(await POST(req))

    expect(status).toBe(200)
    expect(body.data).toEqual({
      ok: true,
      pending_email: 'new@testbrand.example',
      resent: false,
    })
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('proceeds without the claim when the RPC itself fails', async () => {
    const { updateUser, rpc } = mockUserClient({
      user: { id: 'user-1', email: 'old@testbrand.example' },
      claim: { message: 'function does not exist', code: '42883' },
    })

    const req = createMockRequest('/api/account/email', {
      method: 'POST',
      body: { email: 'new@testbrand.example' },
    })
    const { status } = await parseJsonResponse(await POST(req))

    expect(status).toBe(200)
    expect(updateUser).toHaveBeenCalledTimes(1)
    expect(rpc).not.toHaveBeenCalledWith('release_email_change_request')
  })

  it('releases the claim when GoTrue refuses the change', async () => {
    const { rpc } = mockUserClient({
      user: { id: 'user-1', email: 'old@testbrand.example' },
      updateUserError: {
        message: 'AAL2 session is required',
        status: 403,
        code: 'insufficient_aal',
      },
    })

    const req = createMockRequest('/api/account/email', {
      method: 'POST',
      body: { email: 'new@testbrand.example' },
    })
    const { status } = await parseJsonResponse(await POST(req))

    expect(status).toBe(400)
    expect(rpc).toHaveBeenCalledWith('release_email_change_request')
  })

  it('returns 409 when the address already belongs to another account', async () => {
    mockUserClient({
      user: { id: 'user-1', email: 'old@testbrand.example' },
      updateUserError: {
        message: 'A user with this email address has already been registered',
        status: 422,
        code: 'email_exists',
      },
    })

    const req = createMockRequest('/api/account/email', {
      method: 'POST',
      body: { email: 'taken@testbrand.example' },
    })
    const { status, body } = await parseJsonResponse<{ error?: string }>(
      await POST(req),
    )

    expect(status).toBe(409)
    expect(body.error).toBe('E-postadressen används redan av ett annat konto.')
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
