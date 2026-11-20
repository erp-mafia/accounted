import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase } = createTableMockSupabase()
const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({}) }))
const overviewMock = vi.hoisted(() => vi.fn())
const summaryMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/reminders/overview', () => ({ loadReminderOverview: overviewMock, loadReminderSummary: summaryMock }))

import { GET } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('GET /api/reminders/overview', () => {
  it('returns 401 when not authenticated', async () => {
    const { NextResponse } = await import('next/server')
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await GET(createMockRequest('/api/reminders/overview'), createMockRouteParams({}))).status).toBe(401)
  })

  it("answers the active company's overview", async () => {
    overviewMock.mockResolvedValue({ available: true, enabled: false, pickable: [] })
    const res = await GET(createMockRequest('/api/reminders/overview'), createMockRouteParams({}))
    expect((await parseJsonResponse(res)).body).toEqual({ data: { available: true, enabled: false, pickable: [] } })
    expect(overviewMock).toHaveBeenCalledWith(expect.anything(), 'company-1', expect.objectContaining({ now: expect.any(Date) }))
    expect(summaryMock).not.toHaveBeenCalled()
  })

  it('answers only the summary for view=summary, without building the pick list', async () => {
    summaryMock.mockResolvedValue({ available: true, enabled: false, enabledAt: null, collectionsConnected: false, offerableCount: 2 })
    const res = await GET(createMockRequest('/api/reminders/overview', { searchParams: { view: 'summary' } }), createMockRouteParams({}))
    expect((await parseJsonResponse(res)).body).toEqual({
      data: { available: true, enabled: false, enabledAt: null, collectionsConnected: false, offerableCount: 2 },
    })
    expect(summaryMock).toHaveBeenCalledWith(expect.anything(), 'company-1', expect.objectContaining({ now: expect.any(Date) }))
    expect(overviewMock).not.toHaveBeenCalled()
  })

  it('returns 400 for an unknown view', async () => {
    const res = await GET(createMockRequest('/api/reminders/overview', { searchParams: { view: 'everything' } }), createMockRouteParams({}))
    expect(res.status).toBe(400)
    expect(overviewMock).not.toHaveBeenCalled()
    expect(summaryMock).not.toHaveBeenCalled()
  })
})
