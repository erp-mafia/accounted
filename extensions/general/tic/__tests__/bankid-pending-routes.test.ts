/**
 * Self-service for a pending BankID account (address unproven): re-send the
 * verification mail, or swap the typed address. Both need a session and the
 * bankid_pending flag; neither touches a verified account.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

vi.mock('../lib/bankid-confirmation-mail', () => ({
  sendBankIdSignupConfirmation: vi.fn(),
}))

import { createServiceClient } from '@/lib/supabase/server'
import { sendBankIdSignupConfirmation } from '../lib/bankid-confirmation-mail'
import { bankIdPendingRoutes, RESEND_COOLDOWN_MS } from '../lib/bankid-pending-routes'

const pendingUser = {
  id: 'user-1',
  email: 'typed@example.com',
  app_metadata: { bankid_pending: true, has_password: false },
}

function handler(path: string) {
  const route = bankIdPendingRoutes.find((r) => r.path === path)
  if (!route) throw new Error(`route ${path} not found`)
  return route.handler
}

function mockService(user: unknown) {
  const admin = {
    getUserById: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    updateUserById: vi.fn().mockResolvedValue({ data: {}, error: null }),
  }
  vi.mocked(createServiceClient).mockReturnValue({ auth: { admin } } as never)
  return admin
}

function req(path: string, body?: unknown) {
  return createMockRequest(`/api/extensions/ext/tic/bankid/pending/${path}`, {
    method: 'POST',
    headers: { 'x-forwarded-host': 'app.gnubok.se', 'x-forwarded-proto': 'https' },
    body: body ?? {},
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, error: null })
  vi.mocked(sendBankIdSignupConfirmation).mockResolvedValue({ ok: true })
})

describe('POST /bankid/pending/resend', () => {
  it('returns 401 without a session', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(await handler('/bankid/pending/resend')(req('resend')))
    expect(status).toBe(401)
  })

  it('refuses a verified account (nothing to re-send)', async () => {
    mockService({ ...pendingUser, app_metadata: { bankid_linked: true } })
    const { status, body } = await parseJsonResponse<{ error: string }>(
      await handler('/bankid/pending/resend')(req('resend')),
    )
    expect(status).toBe(400)
    expect(body.error).toBe('not_pending')
    expect(sendBankIdSignupConfirmation).not.toHaveBeenCalled()
  })

  it('re-sends to the typed address on the originating host and stamps the send', async () => {
    const admin = mockService(pendingUser)
    const { status, body } = await parseJsonResponse<{ data: { sent: boolean; email: string } }>(
      await handler('/bankid/pending/resend')(req('resend')),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ sent: true, email: 'typed@example.com' })
    expect(sendBankIdSignupConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'typed@example.com', host: 'app.gnubok.se', proto: 'https' }),
    )
    // Read-merge-write: the flags survive the stamp.
    expect(admin.updateUserById).toHaveBeenCalledWith('user-1', {
      app_metadata: {
        bankid_pending: true,
        has_password: false,
        bankid_pending_mail_sent_at: expect.any(String),
      },
    })
  })

  it('answers 429 inside the cooldown window', async () => {
    mockService({
      ...pendingUser,
      app_metadata: {
        ...pendingUser.app_metadata,
        bankid_pending_mail_sent_at: new Date(Date.now() - RESEND_COOLDOWN_MS / 2).toISOString(),
      },
    })
    const { status, body } = await parseJsonResponse<{ error: string; retryAfterMs: number }>(
      await handler('/bankid/pending/resend')(req('resend')),
    )
    expect(status).toBe(429)
    expect(body.error).toBe('cooldown')
    expect(body.retryAfterMs).toBeGreaterThan(0)
    expect(sendBankIdSignupConfirmation).not.toHaveBeenCalled()
  })

  it('sends again once the cooldown has passed', async () => {
    mockService({
      ...pendingUser,
      app_metadata: {
        ...pendingUser.app_metadata,
        bankid_pending_mail_sent_at: new Date(Date.now() - RESEND_COOLDOWN_MS - 1000).toISOString(),
      },
    })
    const { status } = await parseJsonResponse(await handler('/bankid/pending/resend')(req('resend')))
    expect(status).toBe(200)
    expect(sendBankIdSignupConfirmation).toHaveBeenCalledTimes(1)
  })

  it('answers 500 when the mail cannot be sent', async () => {
    mockService(pendingUser)
    vi.mocked(sendBankIdSignupConfirmation).mockResolvedValue({ ok: false, step: 'send' })
    const { status, body } = await parseJsonResponse<{ error: string }>(
      await handler('/bankid/pending/resend')(req('resend')),
    )
    expect(status).toBe(500)
    expect(body.error).toBe('internal_error')
  })
})

describe('POST /bankid/pending/change-email', () => {
  it('returns 401 without a session', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(
      await handler('/bankid/pending/change-email')(req('change-email', { email: 'new@example.com' })),
    )
    expect(status).toBe(401)
  })

  it('returns 400 for an invalid address', async () => {
    mockService(pendingUser)
    const { status } = await parseJsonResponse(
      await handler('/bankid/pending/change-email')(req('change-email', { email: 'not-an-address' })),
    )
    expect(status).toBe(400)
    expect(sendBankIdSignupConfirmation).not.toHaveBeenCalled()
  })

  it('refuses a verified account', async () => {
    const admin = mockService({ ...pendingUser, app_metadata: { bankid_linked: true } })
    const { status, body } = await parseJsonResponse<{ error: string }>(
      await handler('/bankid/pending/change-email')(req('change-email', { email: 'new@example.com' })),
    )
    expect(status).toBe(400)
    expect(body.error).toBe('not_pending')
    expect(admin.updateUserById).not.toHaveBeenCalled()
  })

  it('changes the address without asking the old one, and mails the new one at once', async () => {
    const admin = mockService({
      ...pendingUser,
      app_metadata: {
        ...pendingUser.app_metadata,
        // A fresh address ignores the old one's cooldown.
        bankid_pending_mail_sent_at: new Date().toISOString(),
      },
    })
    const { status, body } = await parseJsonResponse<{ data: { email: string; sent: boolean } }>(
      await handler('/bankid/pending/change-email')(req('change-email', { email: ' New@Example.com ' })),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ email: 'new@example.com', sent: true })
    // email_confirm keeps the password grant of the next BankID login working;
    // the pending flag is what says the address is unproven.
    expect(admin.updateUserById).toHaveBeenCalledWith('user-1', {
      email: 'new@example.com',
      email_confirm: true,
    })
    expect(sendBankIdSignupConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new@example.com' }),
    )
  })

  it('answers 409 when the address belongs to another account', async () => {
    const admin = mockService(pendingUser)
    admin.updateUserById.mockResolvedValueOnce({
      data: null,
      error: { code: 'email_exists', message: 'taken' },
    })
    const { status, body } = await parseJsonResponse<{ error: string }>(
      await handler('/bankid/pending/change-email')(req('change-email', { email: 'taken@example.com' })),
    )
    expect(status).toBe(409)
    expect(body.error).toBe('account_exists')
    expect(sendBankIdSignupConfirmation).not.toHaveBeenCalled()
  })

  it('reports a changed address whose mail failed, so the re-send is the retry', async () => {
    mockService(pendingUser)
    vi.mocked(sendBankIdSignupConfirmation).mockResolvedValue({ ok: false, step: 'send' })
    const { status, body } = await parseJsonResponse<{ error: string; email: string }>(
      await handler('/bankid/pending/change-email')(req('change-email', { email: 'new@example.com' })),
    )
    expect(status).toBe(502)
    expect(body.error).toBe('mail_failed')
    expect(body.email).toBe('new@example.com')
  })
})
