import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getActiveCompanyId: vi.fn(),
  requireWritePermission: vi.fn(),
  buildReport: vi.fn(),
  stageMonthLock: vi.fn(),
}))

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: mocks.requireAuth }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: mocks.getActiveCompanyId,
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: mocks.requireWritePermission,
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(() => ({})),
}))
vi.mock('@/lib/close-run', () => ({
  buildMonthEndReadinessReport: mocks.buildReport,
  stageMonthLock: mocks.stageMonthLock,
}))

import { POST } from '../route'

function makeReport(overrides: Record<string, unknown> = {}) {
  return {
    companyId: 'company-1',
    month: '2026-06',
    start: '2026-06-01',
    end: '2026-06-30',
    lockedThrough: null,
    alreadyLocked: false,
    checks: [],
    ready: true,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireAuth.mockResolvedValue({ user: { id: 'user-1' }, supabase: {}, error: null })
  mocks.getActiveCompanyId.mockResolvedValue('company-1')
  mocks.requireWritePermission.mockResolvedValue({ ok: true })
  mocks.buildReport.mockResolvedValue(makeReport())
  mocks.stageMonthLock.mockResolvedValue({ operationId: 'op-1', alreadyStaged: false })
})

describe('POST /api/close-run/lock', () => {
  it('401 when unauthenticated', async () => {
    const { NextResponse } = await import('next/server')
    mocks.requireAuth.mockResolvedValue({
      user: null,
      supabase: null,
      error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    })
    const res = await POST(createMockRequest('/api/close-run/lock', { method: 'POST', body: { month: '2026-06' } }))
    expect(res.status).toBe(401)
  })

  it('400 on a malformed month', async () => {
    const res = await POST(createMockRequest('/api/close-run/lock', { method: 'POST', body: { month: 'juni-2026' } }))
    expect(res.status).toBe(400)
    expect(mocks.stageMonthLock).not.toHaveBeenCalled()
  })

  it('409 when the month is already locked', async () => {
    mocks.buildReport.mockResolvedValue(
      makeReport({ alreadyLocked: true, lockedThrough: '2026-06-30' }),
    )
    const res = await POST(createMockRequest('/api/close-run/lock', { method: 'POST', body: { month: '2026-06' } }))
    expect(res.status).toBe(409)
    expect(mocks.stageMonthLock).not.toHaveBeenCalled()
  })

  it('happy path stages the lock and returns the readiness report', async () => {
    const res = await POST(createMockRequest('/api/close-run/lock', { method: 'POST', body: { month: '2026-06' } }))
    const { status, body } = await parseJsonResponse<{
      data: { operationId: string; alreadyStaged: boolean; report: { ready: boolean } }
    }>(res)
    expect(status).toBe(200)
    expect(body.data.operationId).toBe('op-1')
    expect(body.data.report.ready).toBe(true)
    expect(mocks.stageMonthLock).toHaveBeenCalledWith(expect.anything(), {
      companyId: 'company-1',
      userId: 'user-1',
      month: '2026-06',
    })
  })
})
