/**
 * Tests for POST /api/company/members/invite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase: serviceSupabase, enqueue, reset } = createQueuedMockSupabase()

// The queued mock's auth object only carries getUser; the provisioning path
// (AUTH_SIGNUPS_DISABLED=true) also calls auth.admin.inviteUserByEmail.
const inviteUserByEmailMock = vi.fn()
Object.assign(serviceSupabase.auth, {
  admin: { inviteUserByEmail: inviteUserByEmailMock },
})

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceSupabase,
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/auth/invite-tokens', () => ({
  generateInviteToken: () => ({ token: 'tok-plain', hash: 'tok-hash' }),
  getInviteExpiry: () => new Date('2026-08-01T00:00:00Z'),
}))

const sendEmailMock = vi.fn()
const isConfiguredMock = vi.fn()
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ isConfigured: isConfiguredMock, sendEmail: sendEmailMock }),
}))

const brandSenderMock = vi.hoisted(() => ({
  getSenderForCompany: vi.fn(),
  getBaseUrlForBrand: vi.fn(),
}))
vi.mock('@/lib/email/brand-sender', () => brandSenderMock)

const generateInviteEmailHtmlMock = vi.hoisted(() =>
  vi.fn((data: { inviteUrl: string }) => `<p>${data.inviteUrl}</p>`),
)
vi.mock('@/lib/email/invite-templates', () => ({
  generateInviteEmailSubject: () => 'subject',
  generateInviteEmailHtml: generateInviteEmailHtmlMock,
  generateInviteEmailText: () => 'text',
}))

import { POST } from '../route'

const routeParams = { params: Promise.resolve({}) }

function post(body: unknown, url = '/api/company/members/invite') {
  return POST(
    createMockRequest(url, { method: 'POST', body }),
    routeParams,
  )
}

const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL
const originalWhiteLabelDomains = process.env.NEXT_PUBLIC_WHITELABEL_DOMAINS

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  delete process.env.AUTH_SIGNUPS_DISABLED
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.test'
  delete process.env.NEXT_PUBLIC_WHITELABEL_DOMAINS
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1', email: 'owner@example.com' },
    supabase: {},
    error: null,
  })
  requireWriteMock.mockResolvedValue({ ok: true })
  isConfiguredMock.mockReturnValue(true)
  sendEmailMock.mockResolvedValue({ success: true, messageId: 'msg-1' })
  brandSenderMock.getSenderForCompany.mockResolvedValue({
    fromName: null,
    fromAddress: null,
    replyTo: null,
    brand: null,
  })
  brandSenderMock.getBaseUrlForBrand.mockReturnValue('http://localhost:3000')
  inviteUserByEmailMock.mockResolvedValue({ data: { user: { id: 'new-user' } }, error: null })
})

afterEach(() => {
  delete process.env.AUTH_SIGNUPS_DISABLED
  if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl

  if (originalWhiteLabelDomains === undefined) {
    delete process.env.NEXT_PUBLIC_WHITELABEL_DOMAINS
  } else {
    process.env.NEXT_PUBLIC_WHITELABEL_DOMAINS = originalWhiteLabelDomains
  }
})

describe('POST /api/company/members/invite', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await post({ email: 'x@y.se' })
    expect(res.status).toBe(401)
  })

  it('refuses non-admin members with 403', async () => {
    enqueue({ data: { role: 'member' } }) // caller membership

    const { status, body } = await parseJsonResponse<{ error: string }>(
      await post({ email: 'x@y.se' })
    )
    expect(status).toBe(403)
    expect(body.error).toBe('Behörighet saknas.')
  })

  it('rejects an invalid email with 400', async () => {
    enqueue({ data: { role: 'owner' } })
    const { status } = await parseJsonResponse(await post({ email: 'not-an-email' }))
    expect(status).toBe(400)
  })

  it('rejects an unknown role with 400', async () => {
    enqueue({ data: { role: 'owner' } })
    const { status } = await parseJsonResponse(
      await post({ email: 'x@y.se', role: 'superuser' })
    )
    expect(status).toBe(400)
  })

  it('creates the invitation and reports email_sent', async () => {
    enqueue({ data: { role: 'owner' } }) // caller membership
    enqueue({ data: [] }) // existing members
    enqueue({ data: null }) // existing invite
    enqueue({ data: { name: 'Acme AB' } }) // company name
    enqueue({ data: null }) // insert invitation

    const { status, body } = await parseJsonResponse<{
      data: { email: string; email_sent: boolean }
    }>(await post({ email: 'Client@Example.com', role: 'viewer' }))

    expect(status).toBe(200)
    expect(body.data.email).toBe('client@example.com') // normalized
    expect(body.data.email_sent).toBe(true)
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'client@example.com' })
    )
  })

  it('sends the branded invite: brand link base, brand appName, brand sender', async () => {
    brandSenderMock.getSenderForCompany.mockResolvedValue({
      fromName: 'Siffra',
      fromAddress: 'noreply@post.siffra.se',
      replyTo: 'support@siffra.se',
      brand: { appName: 'Siffra', domain: 'app.siffra.se' },
    })
    brandSenderMock.getBaseUrlForBrand.mockReturnValue('https://app.siffra.se')

    enqueue({ data: { role: 'owner' } })
    enqueue({ data: [] })
    enqueue({ data: null })
    enqueue({ data: { name: 'Kund AB' } })
    enqueue({ data: null })

    const { status } = await parseJsonResponse(
      await post({ email: 'client@example.com' })
    )

    expect(status).toBe(200)
    expect(generateInviteEmailHtmlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteUrl: 'https://app.siffra.se/invite/tok-plain',
        appName: 'Siffra',
      })
    )
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fromName: 'Siffra',
        fromAddress: 'noreply@post.siffra.se',
        replyTo: 'support@siffra.se',
      })
    )
  })

  it('keeps the canonical link and platform sender for an unbranded company', async () => {
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: [] })
    enqueue({ data: null })
    enqueue({ data: { name: 'Kund AB' } })
    enqueue({ data: null })

    const { status } = await parseJsonResponse(
      await post({ email: 'client@example.com' })
    )

    expect(status).toBe(200)
    expect(generateInviteEmailHtmlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteUrl: 'https://app.accounted.test/invite/tok-plain',
        appName: undefined,
      })
    )
    const options = sendEmailMock.mock.calls[0][0]
    expect(options.fromName).toBeUndefined()
    expect(options.fromAddress).toBeUndefined()
    expect(options.replyTo).toBeUndefined()
  })

  it('reports email_sent=false when the send fails (invite still created)', async () => {
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: [] })
    enqueue({ data: null })
    enqueue({ data: { name: 'Acme AB' } })
    enqueue({ data: null })
    sendEmailMock.mockResolvedValue({ success: false, error: 'smtp down' })

    const { status, body } = await parseJsonResponse<{
      data: { email_sent: boolean; status: string }
    }>(await post({ email: 'client@example.com' }))

    expect(status).toBe(200)
    expect(body.data.status).toBe('pending')
    expect(body.data.email_sent).toBe(false)
  })

  it('uses a registered white-label request host in the invitation email', async () => {
    process.env.NEXT_PUBLIC_WHITELABEL_DOMAINS = 'portal.brand.test'
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: [] })
    enqueue({ data: null })
    enqueue({ data: { name: 'Acme AB' } })
    enqueue({ data: null })

    const { status } = await parseJsonResponse(
      await post(
        { email: 'client@example.com' },
        'https://portal.brand.test/api/company/members/invite',
      ),
    )

    expect(status).toBe(200)
    expect(generateInviteEmailHtmlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteUrl: 'https://portal.brand.test/invite/tok-plain',
      }),
    )
  })

  it('falls back to the canonical app for an untrusted spoofed request host', async () => {
    process.env.NEXT_PUBLIC_WHITELABEL_DOMAINS = 'portal.brand.test'
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: [] })
    enqueue({ data: null })
    enqueue({ data: { name: 'Acme AB' } })
    enqueue({ data: null })

    const { status } = await parseJsonResponse(
      await post(
        { email: 'client@example.com' },
        'https://portal.brand.test.attacker.test/api/company/members/invite',
      ),
    )

    expect(status).toBe(200)
    expect(generateInviteEmailHtmlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteUrl: 'https://app.accounted.test/invite/tok-plain',
      }),
    )
  })
})

describe('POST /api/company/members/invite: AUTH_SIGNUPS_DISABLED provisioning', () => {
  it('leaves behavior unchanged when the flag is unset: no existence check, no admin call', async () => {
    enqueue({ data: { role: 'owner' } }) // caller membership
    enqueue({ data: [] }) // existing members
    enqueue({ data: null }) // existing invite
    enqueue({ data: { name: 'Acme AB' } }) // company name
    enqueue({ data: null }) // insert invitation

    const { status, body } = await parseJsonResponse<{
      data: { email_sent: boolean; user_provisioned: boolean }
    }>(await post({ email: 'client@example.com' }))

    expect(status).toBe(200)
    expect(body.data.email_sent).toBe(true)
    expect(body.data.user_provisioned).toBe(false)
    expect(serviceSupabase.rpc).not.toHaveBeenCalled()
    expect(inviteUserByEmailMock).not.toHaveBeenCalled()
  })

  it('flag on + account exists: skips provisioning, invite proceeds normally', async () => {
    process.env.AUTH_SIGNUPS_DISABLED = 'true'
    enqueue({ data: { role: 'owner' } }) // caller membership
    enqueue({ data: [] }) // existing members
    enqueue({ data: null }) // existing invite
    enqueue({ data: { name: 'Acme AB' } }) // company name
    enqueue({ data: true }) // rpc check_email_exists -> account exists
    enqueue({ data: null }) // insert invitation

    const { status, body } = await parseJsonResponse<{
      data: { email_sent: boolean; user_provisioned: boolean }
    }>(await post({ email: 'client@example.com' }))

    expect(status).toBe(200)
    expect(serviceSupabase.rpc).toHaveBeenCalledWith('check_email_exists', {
      email_to_check: 'client@example.com',
    })
    expect(inviteUserByEmailMock).not.toHaveBeenCalled()
    expect(body.data.email_sent).toBe(true)
    expect(body.data.user_provisioned).toBe(false)
  })

  it('flag on + no account: provisions via admin invite with the invite redirect', async () => {
    process.env.AUTH_SIGNUPS_DISABLED = 'true'
    enqueue({ data: { role: 'owner' } }) // caller membership
    enqueue({ data: [] }) // existing members
    enqueue({ data: null }) // existing invite
    enqueue({ data: { name: 'Acme AB' } }) // company name
    enqueue({ data: false }) // rpc check_email_exists -> no account
    enqueue({ data: null }) // insert invitation

    const { status, body } = await parseJsonResponse<{
      data: { email_sent: boolean; user_provisioned: boolean }
    }>(await post({ email: 'Client@Example.com' }))

    expect(status).toBe(200)
    expect(inviteUserByEmailMock).toHaveBeenCalledTimes(1)
    // Provision with the lowercased email (the invitation row and GoTrue
    // both lowercase; /api/team/accept enforces exact email match) and a
    // redirect that lands back on this invitation.
    expect(inviteUserByEmailMock).toHaveBeenCalledWith('client@example.com', {
      redirectTo: expect.stringContaining('/invite/tok-plain'),
    })
    expect(body.data.user_provisioned).toBe(true)
    expect(body.data.email_sent).toBe(true)
  })

  it('uses a registered white-label request host for the GoTrue invite redirect', async () => {
    process.env.AUTH_SIGNUPS_DISABLED = 'true'
    process.env.NEXT_PUBLIC_WHITELABEL_DOMAINS = 'portal.brand.test'
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: [] })
    enqueue({ data: null })
    enqueue({ data: { name: 'Acme AB' } })
    enqueue({ data: false })
    enqueue({ data: null })

    const { status } = await parseJsonResponse(
      await post(
        { email: 'client@example.com' },
        'https://portal.brand.test/api/company/members/invite',
      ),
    )

    expect(status).toBe(200)
    expect(inviteUserByEmailMock).toHaveBeenCalledWith('client@example.com', {
      redirectTo: 'https://portal.brand.test/invite/tok-plain',
    })
  })

  it('flag on + provisioning fails: surfaces a Swedish error, sends nothing, logs a masked address', async () => {
    process.env.AUTH_SIGNUPS_DISABLED = 'true'
    enqueue({ data: { role: 'owner' } }) // caller membership
    enqueue({ data: [] }) // existing members
    enqueue({ data: null }) // existing invite
    enqueue({ data: { name: 'Acme AB' } }) // company name
    enqueue({ data: false }) // rpc check_email_exists -> no account
    // Mimic a real GoTrue failure (AuthApiError is an Error instance):
    // SMTP not configured is the typical self-hosted cause.
    const authError = Object.assign(new Error('Error sending invite email'), {
      code: 'unexpected_failure',
      status: 500,
    })
    inviteUserByEmailMock.mockResolvedValue({ data: { user: null }, error: authError })
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { status, body } = await parseJsonResponse<{ error: string }>(
      await post({ email: 'client@example.com' })
    )

    expect(status).toBe(502)
    expect(body.error).toContain('SMTP')
    expect(sendEmailMock).not.toHaveBeenCalled()
    // The failure log carries only a masked invitee address (PII stays out
    // of the log record; the mask survives the logger's own redaction).
    const logged = consoleErrorSpy.mock.calls
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' ')
    expect(logged).toContain('c***@example.com')
    expect(logged).not.toContain('client@example.com')
    consoleErrorSpy.mockRestore()
  })

  it('flag on + existence check errors (RPC missing): warns and provisions anyway', async () => {
    process.env.AUTH_SIGNUPS_DISABLED = 'true'
    enqueue({ data: { role: 'owner' } }) // caller membership
    enqueue({ data: [] }) // existing members
    enqueue({ data: null }) // existing invite
    enqueue({ data: { name: 'Acme AB' } }) // company name
    // The exact failure shape a deployment without migration
    // 20260804140000 produces: PostgREST cannot find the function.
    enqueue({
      data: null,
      error: {
        message: 'Could not find the function public.check_email_exists(email_to_check) in the schema cache',
        code: 'PGRST202',
      },
    }) // rpc check_email_exists -> error
    enqueue({ data: null }) // insert invitation

    const { status, body } = await parseJsonResponse<{
      data: { email_sent: boolean; user_provisioned: boolean }
    }>(await post({ email: 'client@example.com' }))

    // The route logs a warning and treats GoTrue as the authority: it
    // attempts provisioning anyway rather than silently skipping the
    // invitee, and a duplicate would surface from GoTrue itself.
    expect(status).toBe(200)
    expect(serviceSupabase.rpc).toHaveBeenCalledWith('check_email_exists', {
      email_to_check: 'client@example.com',
    })
    expect(inviteUserByEmailMock).toHaveBeenCalledTimes(1)
    expect(body.data.user_provisioned).toBe(true)
    expect(body.data.email_sent).toBe(true)
  })

  it('flag on + admin reports the email already registered: treated as existing account', async () => {
    process.env.AUTH_SIGNUPS_DISABLED = 'true'
    enqueue({ data: { role: 'owner' } }) // caller membership
    enqueue({ data: [] }) // existing members
    enqueue({ data: null }) // existing invite
    enqueue({ data: { name: 'Acme AB' } }) // company name
    enqueue({ data: false }) // rpc check_email_exists -> stale answer
    enqueue({ data: null }) // insert invitation
    const authError = Object.assign(
      new Error('A user with this email address has already been registered'),
      { code: 'email_exists', status: 422 },
    )
    inviteUserByEmailMock.mockResolvedValue({ data: { user: null }, error: authError })

    const { status, body } = await parseJsonResponse<{
      data: { email_sent: boolean; user_provisioned: boolean }
    }>(await post({ email: 'client@example.com' }))

    expect(status).toBe(200)
    expect(body.data.user_provisioned).toBe(false)
    expect(body.data.email_sent).toBe(true)
  })
})
