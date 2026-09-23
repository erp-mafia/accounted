/**
 * Tests for GET/PATCH /api/bookkeeping/fiscal-periods/{id}/bokslut-checklist
 * (cookie session, withRouteContext). The checklist service is mocked; the
 * wrapper is real.
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

const buildMock = vi.fn()
const setMock = vi.fn()
vi.mock('@/lib/bokslut/checklist', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bokslut/checklist')>('@/lib/bokslut/checklist')
  return {
    ...actual,
    buildBokslutChecklist: (...args: unknown[]) => buildMock(...args),
    setChecklistItem: (...args: unknown[]) => setMock(...args),
  }
})

import { BokslutChecklistError } from '@/lib/bokslut/checklist'
import { GET, PATCH } from '../[id]/bokslut-checklist/route'

const p = (id: string) => ({ params: Promise.resolve({ id }) }) as never
const CHECKLIST = {
  period: { id: 'fy-2026', name: 'Räkenskapsår 2026', period_start: '2026-01-01', period_end: '2026-12-31' },
  items: [],
  summary: { total: 0, done: 0, not_applicable: 0, open: 0 },
}

describe('bokslut checklist route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    buildMock.mockResolvedValue(CHECKLIST)
    setMock.mockResolvedValue({ item_key: 'inventory_valued', state: 'done' })
  })

  it('401 without a session', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await GET(createMockRequest('http://localhost/x'), p('fy-2026'))
    expect(res.status).toBe(401)
  })

  it('GET returns the checklist for the period and 404s a foreign one', async () => {
    const res = await GET(createMockRequest('http://localhost/x'), p('fy-2026'))
    expect(res.status).toBe(200)
    const { body } = await parseJsonResponse<{ data: { period: { id: string } } }>(res)
    expect(body.data.period.id).toBe('fy-2026')
    expect(buildMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'fy-2026')

    buildMock.mockResolvedValue(null)
    const missing = await GET(createMockRequest('http://localhost/x'), p('nope'))
    expect(missing.status).toBe(404)
  })

  it('PATCH validates the body, ticks the item as the user, and returns the refreshed checklist', async () => {
    const res = await PATCH(
      createMockRequest('http://localhost/x', { method: 'PATCH', body: { item_key: 'inventory_valued', state: 'done', note: 'Inventerat' } }),
      p('fy-2026'),
    )
    expect(res.status).toBe(200)
    expect(setMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'fy-2026', { item_key: 'inventory_valued', state: 'done', note: 'Inventerat' })
    // Existence check without recomputing readiness, then the full rebuild.
    expect(buildMock).toHaveBeenNthCalledWith(1, supabase, 'company-1', 'user-1', 'fy-2026', { readiness: null })
    expect(buildMock).toHaveBeenNthCalledWith(2, supabase, 'company-1', 'user-1', 'fy-2026')

    const bad = await PATCH(createMockRequest('http://localhost/x', { method: 'PATCH', body: { item_key: 'inventory_valued', state: 'maybe' } }), p('fy-2026'))
    expect(bad.status).toBe(400)
    const notJson = await PATCH(new Request('http://localhost/x', { method: 'PATCH', body: '{' }) as never, p('fy-2026'))
    expect(notJson.status).toBe(400)
  })

  it('PATCH maps policy refusals to 400 + code, 404s a foreign period, and requires write permission', async () => {
    setMock.mockRejectedValue(new BokslutChecklistError('Okänt steg.', 'UNKNOWN_ITEM'))
    const refused = await PATCH(createMockRequest('http://localhost/x', { method: 'PATCH', body: { item_key: 'nope', state: 'done' } }), p('fy-2026'))
    expect(refused.status).toBe(400)
    expect((await parseJsonResponse<{ code: string }>(refused)).body.code).toBe('UNKNOWN_ITEM')

    buildMock.mockResolvedValue(null)
    const missing = await PATCH(createMockRequest('http://localhost/x', { method: 'PATCH', body: { item_key: 'no_drafts', state: 'done' } }), p('nope'))
    expect(missing.status).toBe(404)

    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Läsbehörighet' }, { status: 403 }) })
    const forbidden = await PATCH(createMockRequest('http://localhost/x', { method: 'PATCH', body: { item_key: 'no_drafts', state: 'done' } }), p('fy-2026'))
    expect(forbidden.status).toBe(403)
  })
})
