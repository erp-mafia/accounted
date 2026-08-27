/**
 * Tests for POST /api/auth/email-hook (Supabase Send Email hook).
 *
 * Unauthenticated by design: the guard is the Standard Webhooks signature.
 * Signature material is computed with node:crypto exactly like Supabase does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac, randomBytes } from 'node:crypto'
import type { Brand } from '@/lib/branding/resolve'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const resolveBrandByHostMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandByHost: resolveBrandByHostMock,
  // Imported by lib/email/brand-sender (not called on the hook path).
  resolveBrandForCompany: vi.fn(),
}))

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Accounted', appUrl: 'https://app.gnubok.se' }),
}))

const sendEmailMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ sendEmail: sendEmailMock, isConfigured: () => true }),
}))

import { POST } from '../route'

const KEY = randomBytes(24)
const SECRET = `v1,whsec_${KEY.toString('base64')}`

function makeBrand(overrides: Partial<Brand> = {}): Brand {
  return {
    id: 'brand-1',
    teamId: 'team-1',
    domain: 'app.siffra.se',
    appName: 'Siffra',
    logoUrl: null,
    brandColor: '#123456',
    chromeColor: null,
    fontKey: 'default',
    supportEmail: 'support@siffra.se',
    authEmailFrom: 'noreply@post.siffra.se',
    senderDomain: 'post.siffra.se',
    senderDomainStatus: 'verified',
    resendDomainId: 'rd-1',
    signupMode: 'open',
    ...overrides,
  }
}

function signedRequest(rawBody: string, opts?: { badSignature?: boolean; headers?: Record<string, string> }): Request {
  const id = 'msg_1'
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = createHmac('sha256', KEY)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64')
  return new Request('http://localhost:3000/api/auth/email-hook', {
    method: 'POST',
    body: rawBody,
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': opts?.badSignature ? 'v1,AAAA' : `v1,${signature}`,
      ...opts?.headers,
    },
  })
}

function hookPayload(overrides?: {
  user?: Record<string, unknown>
  email_data?: Record<string, unknown>
}): string {
  return JSON.stringify({
    user: { email: 'user@example.se', ...overrides?.user },
    email_data: {
      token: '123456',
      token_hash: 'hash-1',
      redirect_to: 'https://app.gnubok.se/auth/callback?next=/reset-password',
      email_action_type: 'recovery',
      site_url: 'https://app.gnubok.se',
      ...overrides?.email_data,
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.SUPABASE_SEND_EMAIL_HOOK_SECRET = SECRET
  resolveBrandByHostMock.mockResolvedValue(null)
  sendEmailMock.mockResolvedValue({ success: true, messageId: 'msg-1' })
})

afterEach(() => {
  delete process.env.SUPABASE_SEND_EMAIL_HOOK_SECRET
})

describe('POST /api/auth/email-hook', () => {
  it('returns 500 when the hook secret is not configured', async () => {
    delete process.env.SUPABASE_SEND_EMAIL_HOOK_SECRET
    const res = await POST(signedRequest(hookPayload()))
    expect(res.status).toBe(500)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('returns 401 for an invalid signature', async () => {
    const res = await POST(signedRequest(hookPayload(), { badSignature: true }))
    expect(res.status).toBe(401)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('returns 400 for a signed but malformed payload', async () => {
    const res = await POST(signedRequest('not-json'))
    expect(res.status).toBe(400)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('sends canonical recovery mail linking to the originating host (no brand)', async () => {
    const res = await POST(signedRequest(hookPayload()))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({})

    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const options = sendEmailMock.mock.calls[0][0]
    expect(options.to).toBe('user@example.se')
    expect(options.subject).toBe('Återställ ditt lösenord')
    expect(options.fromName).toBeUndefined()
    expect(options.fromAddress).toBeUndefined()
    expect(options.replyTo).toBeUndefined()
    // token_hash + verifyOtp pattern on the originating host, preserving the
    // existing next=/reset-password query.
    expect(options.text).toContain('https://app.gnubok.se/auth/callback?next=%2Freset-password')
    expect(options.text).toContain('token_hash=hash-1')
    expect(options.text).toContain('type=recovery')
  })

  it('brands the mail from the redirect_to host and rides the verified brand sender', async () => {
    resolveBrandByHostMock.mockResolvedValue(makeBrand())
    const res = await POST(
      signedRequest(
        hookPayload({
          email_data: {
            email_action_type: 'signup',
            redirect_to: 'https://app.siffra.se/auth/callback',
          },
        }),
      ),
    )
    expect(res.status).toBe(200)
    expect(resolveBrandByHostMock).toHaveBeenCalledWith('app.siffra.se')

    const options = sendEmailMock.mock.calls[0][0]
    expect(options.fromName).toBe('Siffra')
    expect(options.fromAddress).toBe('noreply@post.siffra.se')
    expect(options.replyTo).toBe('support@siffra.se')
    expect(options.html).toContain('Siffra')
    expect(options.html).not.toMatch(/accounted/i)
    expect(options.text).toContain('https://app.siffra.se/auth/callback?token_hash=hash-1')
    expect(options.text).toContain('type=signup')
  })

  it('uses the via-fallback for a brand without a verified sender domain', async () => {
    resolveBrandByHostMock.mockResolvedValue(makeBrand({ senderDomainStatus: 'pending' }))
    await POST(
      signedRequest(
        hookPayload({
          email_data: {
            email_action_type: 'magiclink',
            redirect_to: 'https://app.siffra.se/auth/callback',
          },
        }),
      ),
    )
    const options = sendEmailMock.mock.calls[0][0]
    expect(options.fromName).toBe('Siffra')
    expect(options.fromAddress).toBeUndefined()
  })

  it('sends two mails for a secure email change', async () => {
    await POST(
      signedRequest(
        hookPayload({
          user: { email: 'current@example.se', new_email: 'new@example.se' },
          email_data: {
            email_action_type: 'email_change',
            token_hash: 'hash-new-address',
            token_hash_new: 'hash-current-address',
            redirect_to: 'https://app.gnubok.se/auth/callback',
          },
        }),
      ),
    )
    expect(sendEmailMock).toHaveBeenCalledTimes(2)
    const first = sendEmailMock.mock.calls[0][0]
    const second = sendEmailMock.mock.calls[1][0]
    // token_hash confirms at the NEW address, token_hash_new at the current.
    expect(first.to).toBe('new@example.se')
    expect(first.text).toContain('token_hash=hash-new-address')
    expect(second.to).toBe('current@example.se')
    expect(second.text).toContain('token_hash=hash-current-address')
  })

  it('sends the OTP code for reauthentication without a link', async () => {
    await POST(
      signedRequest(
        hookPayload({
          email_data: { email_action_type: 'reauthentication', token: '424242' },
        }),
      ),
    )
    const options = sendEmailMock.mock.calls[0][0]
    expect(options.subject).toBe('Din verifieringskod')
    expect(options.text).toContain('424242')
    expect(options.text).not.toContain('token_hash=')
  })

  it('builds the callback URL when redirect_to points at a plain path', async () => {
    await POST(
      signedRequest(
        hookPayload({
          email_data: {
            email_action_type: 'magiclink',
            redirect_to: 'https://app.gnubok.se/settings/account',
          },
        }),
      ),
    )
    const options = sendEmailMock.mock.calls[0][0]
    expect(options.text).toContain('https://app.gnubok.se/auth/callback?next=%2Fsettings%2Faccount')
    expect(options.text).toContain('type=magiclink')
  })

  it('returns 500 when the email provider fails, so Supabase retries', async () => {
    sendEmailMock.mockResolvedValue({ success: false, error: 'provider down' })
    const res = await POST(signedRequest(hookPayload()))
    expect(res.status).toBe(500)
  })
})
