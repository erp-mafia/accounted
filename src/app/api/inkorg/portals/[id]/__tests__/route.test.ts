import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, enqueueMany, findCall, findCalls, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: (...args: unknown[]) => requireWriteMock(...args) }))

import { DELETE, PATCH } from '../route'

const PORTAL_ID = '6f1c2a40-0000-4000-8000-0000000000e5'
const TELIA_ROW = {
  id: PORTAL_ID,
  counterparty_key: 'telia sverige',
  vendor_name: 'Telia',
  url: 'https://www.telia.se/foretag/mitt-telia',
  created_at: '2026-10-20T10:00:00Z',
  updated_at: '2026-10-20T11:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'a@b.se' }, supabase: mockSupabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

const patch = (body: unknown, id = PORTAL_ID) =>
  PATCH(createMockRequest(`/api/inkorg/portals/${id}`, { method: 'PATCH', body }), createMockRouteParams({ id }))
const remove = (id = PORTAL_ID) =>
  DELETE(createMockRequest(`/api/inkorg/portals/${id}`, { method: 'DELETE' }), createMockRouteParams({ id }))
const unauthenticated = () =>
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase: mockSupabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })

describe('PATCH /api/inkorg/portals/:id', () => {
  it('returns 401 when not authenticated, and writes nothing', async () => {
    unauthenticated()
    expect((await patch({ url: 'www.telia.se' })).status).toBe(401)
    expect(findCalls('company_portals', 'update')).toHaveLength(0)
  })

  it('refuses a viewer', async () => {
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await patch({ url: 'www.telia.se' })).status).toBe(403)
    expect(findCalls('company_portals', 'update')).toHaveLength(0)
  })

  it('returns 400 without a link, and INKORG_PORTAL_URL_INVALID for one the rule refuses', async () => {
    expect((await patch({})).status).toBe(400)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await patch({ url: 'data:text/html,hej' }))
    expect(status).toBe(400)
    expect(body.error.code).toBe('INKORG_PORTAL_URL_INVALID')
    expect(findCalls('company_portals', 'update')).toHaveLength(0)
  })

  it("returns 404 when the portal is not the company's, or the id is not one", async () => {
    enqueueMany([{ data: null }])
    const missing = await parseJsonResponse<{ error: { code: string } }>(await patch({ url: 'www.telia.se' }))
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('INKORG_PORTAL_NOT_FOUND')

    reset()
    expect((await patch({ url: 'www.telia.se' }, 'not-a-uuid')).status).toBe(404)
    expect(findCalls('company_portals', 'update')).toHaveLength(0)
  })

  it('stores the new link as the rule leaves it, for the company only', async () => {
    enqueueMany([{ data: TELIA_ROW }])
    const { status, body } = await parseJsonResponse<{ data: unknown }>(
      await patch({ url: 'www.telia.se/foretag/mitt-telia?ref=mail' }),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual(TELIA_ROW)
    expect(findCall('company_portals', 'update')).toEqual([{ url: 'https://www.telia.se/foretag/mitt-telia' }])
    expect(findCalls('company_portals', 'eq')).toEqual(
      expect.arrayContaining([['company_id', 'company-1'], ['id', PORTAL_ID]]),
    )
  })
})

describe('DELETE /api/inkorg/portals/:id', () => {
  it('returns 401 when not authenticated, and deletes nothing', async () => {
    unauthenticated()
    expect((await remove()).status).toBe(401)
    expect(findCalls('company_portals', 'delete')).toHaveLength(0)
  })

  it('refuses a viewer', async () => {
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await remove()).status).toBe(403)
    expect(findCalls('company_portals', 'delete')).toHaveLength(0)
  })

  it("returns 404 when the portal is not the company's, or the id is not one", async () => {
    enqueueMany([{ data: null }])
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await remove())
    expect(status).toBe(404)
    expect(body.error.code).toBe('INKORG_PORTAL_NOT_FOUND')

    reset()
    expect((await remove('../everything')).status).toBe(404)
    expect(findCalls('company_portals', 'delete')).toHaveLength(0)
  })

  it('takes the portal away, for the company only', async () => {
    enqueueMany([{ data: { id: PORTAL_ID } }])
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await remove())
    expect(status).toBe(200)
    expect(body.data).toEqual({ id: PORTAL_ID })
    expect(findCalls('company_portals', 'eq')).toEqual(
      expect.arrayContaining([['company_id', 'company-1'], ['id', PORTAL_ID]]),
    )
  })
})
