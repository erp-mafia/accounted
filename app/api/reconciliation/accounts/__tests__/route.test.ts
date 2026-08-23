/**
 * Tests for the dashboard reconciliation routes (cookie session, withRouteContext):
 * GET /api/reconciliation/accounts, GET .../accounts/{accountKey},
 * GET .../accounts/{accountKey}/items, POST .../links, DELETE .../links/{linkId},
 * POST .../items/{itemId}/ignore. The service layer is mocked; the wrapper is real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

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
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const listAccountsMock = vi.fn()
const statusMock = vi.fn()
const itemsMock = vi.fn()
const matchMock = vi.fn()
const unmatchMock = vi.fn()
const ignoreMock = vi.fn()
vi.mock('@/lib/reconciliation/service', () => ({
  listReconciliationAccounts: (...args: unknown[]) => listAccountsMock(...args),
  getAccountStatus: (...args: unknown[]) => statusMock(...args),
}))
vi.mock('@/lib/reconciliation/items', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reconciliation/items')>('@/lib/reconciliation/items')
  return { ...actual, listAccountItems: (...args: unknown[]) => itemsMock(...args) }
})
vi.mock('@/lib/reconciliation/actions', () => ({
  matchPairs: (...args: unknown[]) => matchMock(...args),
  unmatchLink: (...args: unknown[]) => unmatchMock(...args),
  setItemIgnored: (...args: unknown[]) => ignoreMock(...args),
}))

import { GET as listGET } from '../route'
import { GET as statusGET } from '../[accountKey]/route'
import { GET as itemsGET } from '../[accountKey]/items/route'
import { POST as linksPOST } from '../[accountKey]/links/route'
import { DELETE as linkDELETE } from '../[accountKey]/links/[linkId]/route'
import { POST as ignorePOST } from '../[accountKey]/items/[itemId]/ignore/route'

const ROW = '22222222-2222-4222-8222-222222222222'
const ENTRY = '33333333-3333-4333-8333-333333333333'
// Dynamic-route params for the handlers under test; `never` keeps each
// handler's own params type while letting one helper serve all of them.
const p = (obj: Record<string, string>) => ({ params: Promise.resolve(obj) }) as never

describe('dashboard reconciliation routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    listAccountsMock.mockResolvedValue([{ account_key: 'skattekonto' }])
    statusMock.mockResolvedValue({ account_key: 'skattekonto', bridge: [] })
    itemsMock.mockResolvedValue({ items: [], count: 0, total_count: 0, has_more: false, older_unmatched_count: 0 })
    matchMock.mockResolvedValue({ dry_run: false, considered: 1, applied: [], skipped: [] })
    unmatchMock.mockResolvedValue({ external_id: ROW, previous_journal_entry_id: ENTRY })
    ignoreMock.mockResolvedValue({ external_id: ROW, is_ignored: true })
  })

  it('401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await listGET(createMockRequest('/api/reconciliation/accounts'), { params: Promise.resolve({}) })
    expect(res.status).toBe(401)
  })

  it('lists accounts, forwarding the window and with_status', async () => {
    const res = await listGET(
      createMockRequest('/api/reconciliation/accounts?date_from=2026-01-01&date_to=2026-08-20&with_status=false'),
      { params: Promise.resolve({}) },
    )
    expect(res.status).toBe(200)
    const { body } = await parseJsonResponse<{ data: { accounts: unknown[] } }>(res)
    expect(body.data.accounts).toHaveLength(1)
    expect(listAccountsMock).toHaveBeenCalledWith(supabase, 'company-1', {
      windowFrom: '2026-01-01',
      windowTo: '2026-08-20',
      withStatus: false,
    })
  })

  it('status: 404 on an invalid key, 404 when the service finds nothing, 200 otherwise', async () => {
    expect((await statusGET(createMockRequest('/api/reconciliation/accounts/1930'), p({ accountKey: '1930' }))).status).toBe(404)
    statusMock.mockResolvedValueOnce(null)
    expect((await statusGET(createMockRequest('/api/reconciliation/accounts/skattekonto'), p({ accountKey: 'skattekonto' }))).status).toBe(404)
    const res = await statusGET(createMockRequest('/api/reconciliation/accounts/skattekonto?date_from=2026-07-01'), p({ accountKey: 'skattekonto' }))
    expect(res.status).toBe(200)
    expect(statusMock).toHaveBeenLastCalledWith(supabase, 'company-1', 'skattekonto', { windowFrom: '2026-07-01', windowTo: null })
  })

  it('items: validates the bucket and forwards paging', async () => {
    expect((await itemsGET(createMockRequest('/api/reconciliation/accounts/skattekonto/items?bucket=x'), p({ accountKey: 'skattekonto' }))).status).toBe(400)
    const res = await itemsGET(createMockRequest('/api/reconciliation/accounts/skattekonto/items?bucket=proposed&limit=10&offset=20'), p({ accountKey: 'skattekonto' }))
    expect(res.status).toBe(200)
    expect(itemsMock).toHaveBeenCalledWith(supabase, 'company-1', 'skattekonto', expect.objectContaining({ bucket: 'proposed', limit: 10, offset: 20 }))
  })

  it('links: requires write, validates the body, forwards dry_run', async () => {
    requireWriteMock.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ error: 'Read only' }, { status: 403 }) })
    const forbidden = await linksPOST(
      createMockRequest('/api/reconciliation/accounts/skattekonto/links', { method: 'POST', body: { use_proposals: true } }),
      p({ accountKey: 'skattekonto' }),
    )
    expect(forbidden.status).toBe(403)

    const invalid = await linksPOST(
      createMockRequest('/api/reconciliation/accounts/skattekonto/links', { method: 'POST', body: { pairs: [] } }),
      p({ accountKey: 'skattekonto' }),
    )
    expect(invalid.status).toBe(400)

    const res = await linksPOST(
      createMockRequest('/api/reconciliation/accounts/skattekonto/links', {
        method: 'POST',
        body: { pairs: [{ external_ids: [ROW], journal_entry_ids: [ENTRY] }], dry_run: true },
      }),
      p({ accountKey: 'skattekonto' }),
    )
    expect(res.status).toBe(200)
    expect(matchMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      'skattekonto',
      { pairs: [{ external_ids: [ROW], journal_entry_ids: [ENTRY] }] },
      { dryRun: true },
    )
  })

  it('unlink and ignore call the service with the ids', async () => {
    const del = await linkDELETE(createMockRequest(`/api/reconciliation/accounts/skattekonto/links/${ROW}`, { method: 'DELETE' }), p({ accountKey: 'skattekonto', linkId: ROW }))
    expect(del.status).toBe(200)
    expect(unmatchMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'skattekonto', ROW)

    const ign = await ignorePOST(createMockRequest(`/api/reconciliation/accounts/skattekonto/items/${ROW}/ignore`, { method: 'POST', body: { ignored: false } }), p({ accountKey: 'skattekonto', itemId: ROW }))
    expect(ign.status).toBe(200)
    expect(ignoreMock).toHaveBeenCalledWith(supabase, 'company-1', 'skattekonto', ROW, false)
  })
})
