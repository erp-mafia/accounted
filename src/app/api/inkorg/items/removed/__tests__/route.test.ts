import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: (...args: unknown[]) => requireWriteMock(...args) }))

const listMock = vi.fn()
vi.mock('@/lib/operations/inbox-restore', () => ({
  listRemovedInboxItems: (...args: unknown[]) => listMock(...args),
}))

import { GET } from '../route'

const REMOVED = {
  inbox_item_id: '6f1c2a40-0000-4000-8000-0000000000a1',
  document_id: '6f1c2a40-0000-4000-8000-0000000000d1',
  file_name: 'faktura.pdf',
  vendor_name: 'Nordisk Kontorsservice AB',
  amount: 1250,
  currency: 'SEK',
  email_from: 'faktura@example.test',
  email_subject: 'Faktura F-1',
  removed_at: '2026-11-16T09:12:44.000Z',
  removed_by: { actor_type: 'user', user_id: 'user-1' },
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'a@b.se' }, supabase: mockSupabase, error: null })
  listMock.mockResolvedValue({ ok: true, data: { removed_items: [REMOVED] } })
})

const get = () => GET(createMockRequest('/api/inkorg/items/removed'), createMockRouteParams({}))

describe('GET /api/inkorg/items/removed', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: mockSupabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await get()).status).toBe(401)
    expect(listMock).not.toHaveBeenCalled()
  })

  it('lists the deleted items of the active company, a read any member may make', async () => {
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await get())
    expect(status).toBe(200)
    expect(body.data).toEqual({ removed_items: [REMOVED] })
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }))
    expect(requireWriteMock).not.toHaveBeenCalled()
  })

  it('answers the failure in the error envelope when the list could not be read', async () => {
    listMock.mockResolvedValue({ ok: false, code: 'UNKNOWN_ERROR', error: new Error('boom') })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await get())
    expect(status).toBe(500)
    expect(body.error.code).toBeTruthy()
  })
})
