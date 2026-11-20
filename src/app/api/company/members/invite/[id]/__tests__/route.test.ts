/**
 * Tests for POST (re-send) and DELETE (revoke) /api/company/members/invite/[id].
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase: serviceSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

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

const getMultiUserStateMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/entitlements/multi-user', () => ({
  getMultiUserState: (...args: unknown[]) => getMultiUserStateMock(...args),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceSupabase,
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/auth/invite-tokens', () => ({
  generateInviteToken: () => ({ token: 'gnubok_inv_fresh', hash: 'hash-fresh' }),
  getInviteExpiry: () => new Date('2026-10-09T10:00:00Z'),
}))

// The mail itself goes through the real shared helper
// (lib/email/send-company-invite.ts); only its leaf dependencies are mocked,
// the same set the POST /api/company/members/invite tests use.
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

const resolveBrandResultByHostMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandResultByHost: (...args: unknown[]) => resolveBrandResultByHostMock(...args),
}))

const generateInviteEmailHtmlMock = vi.hoisted(() =>
  vi.fn((data: { inviteUrl: string }) => `<p>${data.inviteUrl}</p>`),
)
vi.mock('@/lib/email/invite-templates', () => ({
  generateInviteEmailSubject: () => 'subject',
  generateInviteEmailHtml: generateInviteEmailHtmlMock,
  generateInviteEmailText: () => 'text',
}))

import { POST, DELETE } from '../route'

const routeParams = createMockRouteParams({ id: 'inv-1' })

function post(url = '/api/company/members/invite/inv-1') {
  return POST(createMockRequest(url, { method: 'POST' }), routeParams)
}

function del() {
  return DELETE(createMockRequest('/api/company/members/invite/inv-1', { method: 'DELETE' }), routeParams)
}

// An invitation whose link ran out a week ago: still 'pending' in the
// database, because nothing flips the status when the expiry passes.
const expiredPendingInvite = {
  id: 'inv-1',
  company_id: 'company-1',
  email: 'client@example.com',
  role: 'viewer',
  status: 'pending',
  expires_at: '2026-09-22T10:00:00Z',
}

const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.test'
  resolveBrandResultByHostMock.mockResolvedValue({ brand: null, lookupFailed: false })
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1', email: 'owner@example.com' },
    supabase: {},
    error: null,
  })
  requireWriteMock.mockResolvedValue({ ok: true })
  getMultiUserStateMock.mockResolvedValue({ state: 'entitled', graceEndsAt: null })
  isConfiguredMock.mockReturnValue(true)
  sendEmailMock.mockResolvedValue({ success: true, messageId: 'msg-1' })
  brandSenderMock.getSenderForCompany.mockResolvedValue({
    fromName: null,
    fromAddress: null,
    replyTo: null,
    brand: null,
  })
  brandSenderMock.getBaseUrlForBrand.mockReturnValue('http://localhost:3000')
})

afterEach(() => {
  if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl
})

describe('POST /api/company/members/invite/[id] (re-send)', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await post()
    expect(res.status).toBe(401)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('returns 403 for a caller who is not owner or admin, before looking up the invite', async () => {
    enqueue({ data: { role: 'member' } }) // caller membership

    const { status, body } = await parseJsonResponse<{ error: string }>(await post())

    expect(status).toBe(403)
    expect(body.error).toBe('Behörighet saknas.')
    expect(findCalls('company_invitations', 'select')).toHaveLength(0)
    expect(findCalls('company_invitations', 'update')).toHaveLength(0)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the invitation is not in the active company', async () => {
    enqueue({ data: { role: 'owner' } }) // caller membership
    enqueue({ data: null }) // invitation lookup scoped to company-1: miss

    const { status } = await parseJsonResponse(await post())

    expect(status).toBe(404)
    // The lookup is scoped to the active company, not just the id.
    expect(findCalls('company_invitations', 'eq')).toEqual(
      expect.arrayContaining([
        ['id', 'inv-1'],
        ['company_id', 'company-1'],
      ]),
    )
    expect(findCalls('company_invitations', 'update')).toHaveLength(0)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('returns 409 when the invitation is no longer pending', async () => {
    enqueue({ data: { role: 'admin' } })
    enqueue({ data: { ...expiredPendingInvite, status: 'accepted' } })

    const { status } = await parseJsonResponse(await post())

    expect(status).toBe(409)
    expect(findCalls('company_invitations', 'update')).toHaveLength(0)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('refuses with the seat-gate envelope when multi_user is frozen', async () => {
    getMultiUserStateMock.mockResolvedValue({ state: 'frozen', graceEndsAt: null })
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: expiredPendingInvite })

    const { status, body } = await parseJsonResponse<{
      capability_blocked: boolean
      capability: string
    }>(await post())

    expect(status).toBe(403)
    expect(body.capability_blocked).toBe(true)
    expect(body.capability).toBe('multi_user')
    expect(findCalls('company_invitations', 'update')).toHaveLength(0)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('revives an expired invitation: rotates the token, extends the expiry, re-sends the mail', async () => {
    enqueue({ data: { role: 'owner' } }) // caller membership
    enqueue({ data: expiredPendingInvite }) // invitation lookup
    enqueue({ data: { name: 'Acme AB' } }) // company name
    enqueue({ error: null }) // invitation update

    const { status, body } = await parseJsonResponse<{
      data: {
        id: string
        email: string
        role: string
        status: string
        expires_at: string
        email_sent: boolean
        inviteUrl: string
      }
    }>(await post())

    expect(status).toBe(200)
    expect(body.data).toEqual({
      id: 'inv-1',
      email: 'client@example.com',
      role: 'viewer',
      status: 'pending',
      expires_at: '2026-10-09T10:00:00.000Z',
      email_sent: true,
      inviteUrl: 'https://app.accounted.test/invite/gnubok_inv_fresh',
    })

    // A fresh hash replaces the old one (the previously mailed link dies),
    // the expiry moves forward, and the raw token never touches the DB.
    const updates = findCalls('company_invitations', 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0]![0]).toEqual({
      token_hash: 'hash-fresh',
      invited_by: 'user-1',
      expires_at: '2026-10-09T10:00:00.000Z',
    })

    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'client@example.com' }),
    )
    expect(generateInviteEmailHtmlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        companyName: 'Acme AB',
        inviterEmail: 'owner@example.com',
        inviteUrl: 'https://app.accounted.test/invite/gnubok_inv_fresh',
      }),
    )
  })

  it('keeps the renewed invitation and returns the link when the mail send fails', async () => {
    sendEmailMock.mockResolvedValue({ success: false, error: 'smtp down' })
    enqueue({ data: { role: 'admin' } })
    enqueue({ data: expiredPendingInvite })
    enqueue({ data: { name: 'Acme AB' } })
    enqueue({ error: null })

    const { status, body } = await parseJsonResponse<{
      data: { email_sent: boolean; inviteUrl: string }
    }>(await post())

    expect(status).toBe(200)
    expect(body.data.email_sent).toBe(false)
    expect(body.data.inviteUrl).toBe('https://app.accounted.test/invite/gnubok_inv_fresh')
  })

  it('returns 500 and sends nothing when the token update fails', async () => {
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: expiredPendingInvite })
    enqueue({ data: { name: 'Acme AB' } })
    enqueue({ error: { message: 'boom' } })

    const { status } = await parseJsonResponse(await post())

    expect(status).toBe(500)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('503s before rotating the token when the brand lookup fails', async () => {
    resolveBrandResultByHostMock.mockResolvedValue({ brand: null, lookupFailed: true })
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: expiredPendingInvite })
    enqueue({ data: { name: 'Acme AB' } })

    const { status } = await parseJsonResponse(
      await post('https://portal.brand.test/api/company/members/invite/inv-1'),
    )

    expect(status).toBe(503)
    // The link the invitee already holds is left alone.
    expect(findCalls('company_invitations', 'update')).toHaveLength(0)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/company/members/invite/[id] (revoke)', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await del()
    expect(res.status).toBe(401)
  })

  it('returns 403 for a caller who is not owner or admin', async () => {
    enqueue({ data: { role: 'viewer' } })
    const { status, body } = await parseJsonResponse<{ error: string }>(await del())
    expect(status).toBe(403)
    expect(body.error).toBe('Behörighet saknas.')
    expect(findCalls('company_invitations', 'update')).toHaveLength(0)
  })

  it('returns 404 when the invitation is not in the active company', async () => {
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: null })
    const { status } = await parseJsonResponse(await del())
    expect(status).toBe(404)
  })

  it('returns 400 when the invitation is no longer pending', async () => {
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: { ...expiredPendingInvite, status: 'revoked' } })
    const { status } = await parseJsonResponse(await del())
    expect(status).toBe(400)
    expect(findCalls('company_invitations', 'update')).toHaveLength(0)
  })

  it('revokes a pending invitation', async () => {
    enqueue({ data: { role: 'admin' } })
    enqueue({ data: expiredPendingInvite })
    enqueue({ error: null })

    const { status, body } = await parseJsonResponse<{ data: { revoked: string } }>(await del())

    expect(status).toBe(200)
    expect(body.data).toEqual({ revoked: 'inv-1' })
    const updates = findCalls('company_invitations', 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0]![0]).toEqual({ status: 'revoked' })
  })
})
