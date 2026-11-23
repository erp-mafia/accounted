import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({}) }))
const connect = vi.hoisted(() => ({ activatePendingKivra: vi.fn(), loadCompanyIdentity: vi.fn() }))
vi.mock('@/lib/digital-mailboxes/connect', () => connect)
const getConnection = vi.hoisted(() => vi.fn())
vi.mock('@/lib/digital-mailboxes/connections', () => ({ getConnection }))
vi.mock('@/lib/digital-mailboxes/providers', () => ({
  getDigitalMailboxProviders: () => ({ kivra: { receiver: {}, config: {} }, billo: null }),
}))
const syncConnection = vi.hoisted(() => vi.fn())
vi.mock('@/lib/digital-mailboxes/receive', () => ({ syncConnection, InboxUnavailableError: class extends Error {} }))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

const pending = { id: 'conn-1', company_id: 'company-1', provider: 'kivra', receive_state: 'pending', receive_connected_by: 'user-1' }

function authed() {
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase: { rpc: vi.fn() }, error: null } as never)
}

function sync(provider = 'kivra') {
  return POST(createMockRequest(`/api/digital-mailboxes/${provider}/sync`, { method: 'POST' }), createMockRouteParams({ provider }))
}

describe('POST /api/digital-mailboxes/[provider]/sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getConnection.mockResolvedValue(pending)
    connect.loadCompanyIdentity.mockResolvedValue({ orgNumber: '5560125790' })
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)
    expect((await sync()).status).toBe(401)
  })

  it('returns 404 for an unknown provider', async () => {
    authed()
    expect((await sync('fax')).status).toBe(404)
  })

  it('answers why a waiting Kivra connection is held back, without reading the mailbox', async () => {
    authed()
    connect.activatePendingKivra.mockResolvedValue({ ok: false, code: 'DIGITAL_MAILBOX_NOT_SIGNATORY' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await sync())
    expect(status).toBe(403)
    expect(body.error.code).toBe('DIGITAL_MAILBOX_NOT_SIGNATORY')
    expect(syncConnection).not.toHaveBeenCalled()
  })

  it('answers not connected while Kivra does not list the company yet', async () => {
    authed()
    connect.activatePendingKivra.mockResolvedValue({ ok: true, data: null })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await sync())
    expect(status).toBe(409)
    expect(body.error.code).toBe('DIGITAL_MAILBOX_NOT_CONNECTED')
  })

  it('reads the mailbox once the waiting connection is activated', async () => {
    authed()
    const active = { ...pending, receive_state: 'active', account_ref: 'ck' }
    connect.activatePendingKivra.mockResolvedValue({ ok: true, data: active })
    syncConnection.mockResolvedValue({ filed: 2, already: 0, noFile: 0, failed: 0, more: false })
    const { status, body } = await parseJsonResponse<{ data: { filed: number } }>(await sync())
    expect(status).toBe(200)
    expect(body.data.filed).toBe(2)
    expect(syncConnection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ connection: active }))
  })
})
