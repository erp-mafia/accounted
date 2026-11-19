import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
const isAdmin = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  isCompanyAdmin: isAdmin,
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({}) }))
const connectMock = vi.hoisted(() => ({
  connectKivraReceive: vi.fn(),
  connectBilloReceive: vi.fn(),
  disconnectReceive: vi.fn(),
}))
vi.mock('@/lib/digital-mailboxes/connect', () => connectMock)

import { DELETE, POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

const row = {
  id: 'conn-1',
  company_id: 'company-1',
  provider: 'kivra',
  receive_state: 'pending',
  account_ref: null,
  mailbox_ref: null,
  receive_since: null,
  receive_connected_by: 'user-1',
  receive_connected_at: '2026-10-19T10:00:00Z',
  receive_ended_at: null,
  last_synced_at: null,
  send_state: 'off',
  tenant_ref: null,
  send_activated_by: null,
  send_activated_at: null,
  last_error: null,
  last_error_at: null,
  provider_meta: {},
  created_at: '2026-10-19T10:00:00Z',
  updated_at: '2026-10-19T10:00:00Z',
}

function authed() {
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase: { rpc: vi.fn() }, error: null } as never)
}

describe('/api/digital-mailboxes/[provider]/receive', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAdmin.mockResolvedValue(true)
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)
    const response = await POST(createMockRequest('/api/digital-mailboxes/kivra/receive', { method: 'POST' }), createMockRouteParams({ provider: 'kivra' }))
    expect(response.status).toBe(401)
  })

  it('returns 403 for a member who is not an admin', async () => {
    authed()
    isAdmin.mockResolvedValue(false)
    const response = await POST(createMockRequest('/api/digital-mailboxes/kivra/receive', { method: 'POST' }), createMockRouteParams({ provider: 'kivra' }))
    expect(response.status).toBe(403)
    expect(connectMock.connectKivraReceive).not.toHaveBeenCalled()
  })

  it('returns 404 for an unknown provider', async () => {
    authed()
    const response = await POST(createMockRequest('/api/digital-mailboxes/fax/receive', { method: 'POST' }), createMockRouteParams({ provider: 'fax' }))
    expect(response.status).toBe(404)
  })

  it('starts a Kivra connection and hands back the onboarding link, never the provider keys', async () => {
    authed()
    connectMock.connectKivraReceive.mockResolvedValue({ ok: true, data: { connection: row, onboardingUrl: 'https://sandbox-accounts.kivra.com/register/company/accounted' } })
    const { status, body } = await parseJsonResponse<{ data: { connection: Record<string, unknown>; onboarding_url: string } }>(
      await POST(createMockRequest('/api/digital-mailboxes/kivra/receive', { method: 'POST' }), createMockRouteParams({ provider: 'kivra' })),
    )
    expect(status).toBe(200)
    expect(body.data.onboarding_url).toContain('kivra.com')
    expect(body.data.connection).toMatchObject({ provider: 'kivra', receive_state: 'pending' })
    expect(body.data.connection).not.toHaveProperty('account_ref')
  })

  it('returns 400 for a Billo request without a usable phone number', async () => {
    authed()
    const response = await POST(
      createMockRequest('/api/digital-mailboxes/billo/receive', { method: 'POST', body: { email: 'anna@example.test', phone: 'call me' } }),
      createMockRouteParams({ provider: 'billo' }),
    )
    expect(response.status).toBe(400)
    expect(connectMock.connectBilloReceive).not.toHaveBeenCalled()
  })

  it('creates the Billo mailbox with the phone in E.164 and maps a refusal', async () => {
    authed()
    connectMock.connectBilloReceive.mockResolvedValue({ ok: false, code: 'DIGITAL_MAILBOX_BANKID_REQUIRED' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await POST(
        createMockRequest('/api/digital-mailboxes/billo/receive', { method: 'POST', body: { email: 'anna@example.test', phone: '070-123 45 67' } }),
        createMockRouteParams({ provider: 'billo' }),
      ),
    )
    expect(status).toBe(403)
    expect(body.error.code).toBe('DIGITAL_MAILBOX_BANKID_REQUIRED')
    expect(connectMock.connectBilloReceive).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1', representative: { email: 'anna@example.test', phone: '+46701234567' } }),
    )
  })

  it('disconnects', async () => {
    authed()
    connectMock.disconnectReceive.mockResolvedValue({ ...row, receive_state: 'ended' })
    const { status, body } = await parseJsonResponse<{ data: { connection: { receive_state: string } } }>(
      await DELETE(createMockRequest('/api/digital-mailboxes/kivra/receive', { method: 'DELETE' }), createMockRouteParams({ provider: 'kivra' })),
    )
    expect(status).toBe(200)
    expect(body.data.connection.receive_state).toBe('ended')
  })
})
