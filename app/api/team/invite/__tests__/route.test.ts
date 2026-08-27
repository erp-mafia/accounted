import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

// POST /api/team/invite (WL-08 invite unfreeze): invites are allowed ONLY for
// byrå teams (kind='byra') and only by team owner/admin. Personal teams keep
// the legacy 403 message.

const { supabase: serviceSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceSupabase,
}))

vi.mock('@/lib/auth/invite-tokens', () => ({
  generateInviteToken: () => ({ token: 'gnubok_inv_test-token', hash: 'hash-test-token' }),
  getInviteExpiry: () => new Date('2099-01-08T00:00:00Z'),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const sendEmailMock = vi.fn()
const isConfiguredMock = vi.fn()
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ isConfigured: isConfiguredMock, sendEmail: sendEmailMock }),
}))

// The brand resolver is mocked (no DB); brand-sender and the templates run
// for real so the test covers the actual sender/link wiring.
const resolveBrandForTeamMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandForTeam: resolveBrandForTeamMock,
}))

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Accounted', appUrl: 'https://app.gnubok.se' }),
}))

import { POST } from '../route'

const SIFFRA_BRAND = {
  id: 'brand-1',
  teamId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
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
}

const mockUser = { id: 'user-1', email: 'admin@byra.se' }

const BYRA_TEAM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERSONAL_TEAM_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const UNKNOWN_TEAM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function makeReq(body: unknown) {
  return new Request('http://localhost/api/team/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never
}

const byraMembership = (role: string) => ({
  team_id: BYRA_TEAM_ID,
  role,
  teams: { id: BYRA_TEAM_ID, name: 'Siffran AB', kind: 'byra', created_at: '2026-01-01T00:00:00Z' },
})

const personalMembership = () => ({
  team_id: PERSONAL_TEAM_ID,
  role: 'owner',
  teams: {
    id: PERSONAL_TEAM_ID,
    name: 'Personal',
    kind: 'personal',
    created_at: '2026-01-02T00:00:00Z',
  },
})

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: serviceSupabase, error: null })
  resolveBrandForTeamMock.mockResolvedValue(null)
  isConfiguredMock.mockReturnValue(true)
  sendEmailMock.mockResolvedValue({ success: true, messageId: 'msg-1' })
})

describe('POST /api/team/invite', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: serviceSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(makeReq({ email: 'konsult@byra.se' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 on an invalid email', async () => {
    const res = await POST(makeReq({ email: 'not-an-email' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('returns 403 with the legacy message for a personal-team-only user', async () => {
    enqueue({ data: [personalMembership()] })

    const res = await POST(makeReq({ email: 'konsult@byra.se' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(403)
    expect(body.error).toBe('Teaminbjudningar är inaktiverade. Bjud in via enskilda företag.')
  })

  it('returns 403 with the legacy message when explicitly targeting the personal team', async () => {
    enqueue({ data: [personalMembership(), byraMembership('owner')] })

    const res = await POST(makeReq({ email: 'konsult@byra.se', teamId: PERSONAL_TEAM_ID }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(403)
    expect(body.error).toBe('Teaminbjudningar är inaktiverade. Bjud in via enskilda företag.')
  })

  it('returns 404 for a teamId outside the caller memberships', async () => {
    enqueue({ data: [personalMembership(), byraMembership('owner')] })

    const res = await POST(makeReq({ email: 'konsult@byra.se', teamId: UNKNOWN_TEAM_ID }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
  })

  it('returns 403 when the caller is a plain team member', async () => {
    enqueue({ data: [byraMembership('member'), personalMembership()] })

    const res = await POST(makeReq({ email: 'konsult@byra.se' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(403)
    expect(body.error).toBe('Behörighet saknas.')
  })

  it('creates an invitation and returns the accept link for a byrå admin', async () => {
    // 1. caller memberships (personal + byrå: multi-team is the normal shape)
    enqueue({ data: [personalMembership(), byraMembership('admin')] })
    // 2. profiles lookup (invitee has no account yet)
    enqueue({ data: null })
    // 3. existing invitation lookup
    enqueue({ data: null })
    // 4. team_invitations insert
    enqueue({ data: { id: 'invite-1' } })

    const res = await POST(makeReq({ email: 'Konsult@Byra.se', role: 'member' }))
    const { status, body } = await parseJsonResponse<{
      data: {
        id: string
        teamId: string
        email: string
        role: string
        status: string
        email_sent: boolean
        inviteUrl: string
      }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.id).toBe('invite-1')
    expect(body.data.teamId).toBe(BYRA_TEAM_ID)
    // Email lowercased by the schema
    expect(body.data.email).toBe('konsult@byra.se')
    expect(body.data.role).toBe('member')
    expect(body.data.status).toBe('pending')
    // Brandless team: mail goes out with platform defaults on the canonical URL.
    expect(body.data.email_sent).toBe(true)
    expect(body.data.inviteUrl).toBe('https://app.gnubok.se/invite/gnubok_inv_test-token')
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const mail = sendEmailMock.mock.calls[0]![0] as {
      to: string
      subject: string
      html: string
      fromName?: string
      fromAddress?: string
      replyTo?: string
    }
    expect(mail.to).toBe('konsult@byra.se')
    expect(mail.fromName).toBeUndefined()
    expect(mail.fromAddress).toBeUndefined()
    expect(mail.html).toContain('https://app.gnubok.se/invite/gnubok_inv_test-token')

    // The insert went to team_invitations with the hashed token, never the raw.
    const inserts = findCalls('team_invitations', 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0]![0]).toMatchObject({
      team_id: BYRA_TEAM_ID,
      email: 'konsult@byra.se',
      role: 'member',
      token_hash: 'hash-test-token',
      status: 'pending',
    })
  })

  it('sends the invite mail in the byrå brand: brand sender, brand-domain link', async () => {
    resolveBrandForTeamMock.mockResolvedValue(SIFFRA_BRAND)
    enqueue({ data: [byraMembership('admin')] })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: { id: 'invite-1' } })

    const res = await POST(makeReq({ email: 'konsult@byra.se' }))
    const { status, body } = await parseJsonResponse<{
      data: { email_sent: boolean; inviteUrl: string }
    }>(res)

    expect(status).toBe(200)
    expect(resolveBrandForTeamMock).toHaveBeenCalledWith(BYRA_TEAM_ID)
    expect(body.data.email_sent).toBe(true)
    expect(body.data.inviteUrl).toBe('https://app.siffra.se/invite/gnubok_inv_test-token')
    const mail = sendEmailMock.mock.calls[0]![0] as {
      subject: string
      html: string
      fromName?: string
      fromAddress?: string
      replyTo?: string
    }
    expect(mail.fromName).toBe('Siffra')
    expect(mail.fromAddress).toBe('noreply@post.siffra.se')
    expect(mail.replyTo).toBe('support@siffra.se')
    // Branded byrå: the subject names the byrå in its own casing, with no
    // platform wording ("Du har blivit inbjuden till Siffra").
    expect(mail.subject).toContain('Siffra')
    expect(mail.html).toContain('https://app.siffra.se/invite/gnubok_inv_test-token')
    expect(mail.html).not.toMatch(/accounted/i)
  })

  it('keeps the invitation valid when the mail send fails (email_sent: false)', async () => {
    sendEmailMock.mockResolvedValue({ success: false, error: 'provider down' })
    enqueue({ data: [byraMembership('owner')] })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: { id: 'invite-1' } })

    const res = await POST(makeReq({ email: 'konsult@byra.se' }))
    const { status, body } = await parseJsonResponse<{
      data: { id: string; email_sent: boolean; inviteUrl: string }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.id).toBe('invite-1')
    expect(body.data.email_sent).toBe(false)
    // The accept link is still returned so the inviter can share it directly.
    expect(body.data.inviteUrl).toContain('/invite/gnubok_inv_test-token')
  })

  it('skips the mail when the email service is not configured', async () => {
    isConfiguredMock.mockReturnValue(false)
    enqueue({ data: [byraMembership('owner')] })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: { id: 'invite-1' } })

    const res = await POST(makeReq({ email: 'konsult@byra.se' }))
    const { status, body } = await parseJsonResponse<{
      data: { email_sent: boolean }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.email_sent).toBe(false)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('returns 409 when the invitee is already a team member', async () => {
    enqueue({ data: [byraMembership('owner')] })
    // profiles lookup -> existing account
    enqueue({ data: { id: 'user-2' } })
    // team_members lookup -> already a member
    enqueue({ data: { id: 'tm-2' } })

    const res = await POST(makeReq({ email: 'konsult@byra.se' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(409)
    expect(body.error).toBe('Denna person är redan medlem.')
  })

  it('returns 409 when a live pending invitation already exists', async () => {
    enqueue({ data: [byraMembership('owner')] })
    enqueue({ data: null })
    enqueue({
      data: { id: 'invite-1', status: 'pending', expires_at: '2099-01-01T00:00:00Z' },
    })

    const res = await POST(makeReq({ email: 'konsult@byra.se' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(409)
  })

  it('re-issues a revoked invitation in place', async () => {
    enqueue({ data: [byraMembership('owner')] })
    enqueue({ data: null })
    enqueue({
      data: { id: 'invite-1', status: 'revoked', expires_at: '2099-01-01T00:00:00Z' },
    })
    // team_invitations update
    enqueue({ data: { id: 'invite-1' } })

    const res = await POST(makeReq({ email: 'konsult@byra.se', role: 'admin' }))
    const { status, body } = await parseJsonResponse<{ data: { id: string; role: string } }>(res)
    expect(status).toBe(200)
    expect(body.data.id).toBe('invite-1')
    expect(body.data.role).toBe('admin')

    const updates = findCalls('team_invitations', 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0]![0]).toMatchObject({ status: 'pending', token_hash: 'hash-test-token' })
  })
})
