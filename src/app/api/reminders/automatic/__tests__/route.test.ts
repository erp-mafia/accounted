import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase } = createTableMockSupabase()
const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const isAdminMock = vi.fn()
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  isCompanyAdmin: (...args: unknown[]) => isAdminMock(...args),
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({}) }))
const setMock = vi.hoisted(() => vi.fn())
const stateMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/reminders/automatic', () => ({ setAutomaticReminders: setMock, loadAutomaticReminderState: stateMock }))

import { GET, POST } from '../route'

const post = (body: unknown) => POST(createMockRequest('/api/reminders/automatic', { method: 'POST', body }), createMockRouteParams({}))

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  isAdminMock.mockResolvedValue(true)
})

describe('POST /api/reminders/automatic', () => {
  it('returns 401 when not authenticated', async () => {
    const { NextResponse } = await import('next/server')
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await post({ enabled: true })).status).toBe(401)
  })

  it('returns 403 for a member who is not an owner or administrator', async () => {
    isAdminMock.mockResolvedValue(false)
    expect((await post({ enabled: true })).status).toBe(403)
    expect(setMock).not.toHaveBeenCalled()
  })

  it('returns 400 without a boolean', async () => {
    expect((await post({ enabled: 'yes' })).status).toBe(400)
  })

  it('refuses before three clean batches', async () => {
    setMock.mockResolvedValue({ ok: false, code: 'REMINDERS_AUTOMATIC_NOT_YET' })
    const res = await post({ enabled: true })
    expect(res.status).toBe(409)
    expect(JSON.stringify((await parseJsonResponse(res)).body)).toContain('REMINDERS_AUTOMATIC_NOT_YET')
  })

  it('turns it on as the person, and answers the state', async () => {
    setMock.mockResolvedValue({ ok: true, state: { on: true, since: '2026-12-20T09:00:00Z', eligible: true, cleanStreak: 3 } })
    const res = await post({ enabled: true })
    expect((await parseJsonResponse(res)).body).toEqual({ data: { on: true, since: '2026-12-20T09:00:00Z', eligible: true, cleanStreak: 3 } })
    expect(setMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ companyId: 'company-1', enabled: true, userId: 'user-1' }))
  })
})

describe('GET /api/reminders/automatic', () => {
  it("answers the active company's state", async () => {
    stateMock.mockResolvedValue({ on: false, since: null, eligible: true, cleanStreak: 3 })
    const res = await GET(createMockRequest('/api/reminders/automatic'), createMockRouteParams({}))
    expect((await parseJsonResponse(res)).body).toEqual({ data: { on: false, since: null, eligible: true, cleanStreak: 3 } })
    expect(stateMock).toHaveBeenCalledWith(expect.anything(), 'company-1')
  })
})
