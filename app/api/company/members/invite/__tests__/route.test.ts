/**
 * Tests for POST /api/company/members/invite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase: serviceSupabase, enqueue, reset } = createQueuedMockSupabase()

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

vi.mock('@/lib/email/invite-templates', () => ({
  generateInviteEmailSubject: () => 'subject',
  generateInviteEmailHtml: () => '<p>html</p>',
  generateInviteEmailText: () => 'text',
}))

import { POST } from '../route'

const routeParams = { params: Promise.resolve({}) }

function post(body: unknown) {
  return POST(
    createMockRequest('/api/company/members/invite', { method: 'POST', body }),
    routeParams,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1', email: 'owner@example.com' },
    supabase: {},
    error: null,
  })
  requireWriteMock.mockResolvedValue({ ok: true })
  isConfiguredMock.mockReturnValue(true)
  sendEmailMock.mockResolvedValue({ success: true, messageId: 'msg-1' })
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
})
