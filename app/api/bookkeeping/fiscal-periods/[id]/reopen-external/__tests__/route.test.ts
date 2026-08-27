/**
 * Tests for POST /api/bookkeeping/fiscal-periods/[id]/reopen-external
 * (undo "klarmarkera": reopen a period marked closed in a previous system).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))
vi.mock('@/lib/core/bookkeeping/period-service', () => ({
  reopenExternallyClosedPeriod: vi.fn(),
}))

import { requireAuth } from '@/lib/auth/require-auth'
import { reopenExternallyClosedPeriod } from '@/lib/core/bookkeeping/period-service'
import { POST } from '../route'

const mockReopen = vi.mocked(reopenExternallyClosedPeriod)

function reopenRequest(): Request {
  return createMockRequest('/api/bookkeeping/fiscal-periods/p1/reopen-external', {
    method: 'POST',
  })
}

function mockAuth() {
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { id: 'user-1' },
    supabase: {},
    error: null,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('POST /api/bookkeeping/fiscal-periods/[id]/reopen-external', () => {
  it('returns 401 when not authenticated', async () => {
    ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(reopenRequest(), createMockRouteParams({ id: 'p1' }))
    expect(res.status).toBe(401)
    expect(mockReopen).not.toHaveBeenCalled()
  })

  it('returns 403 when the caller lacks write permission', async () => {
    mockAuth()
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    })
    const res = await POST(reopenRequest(), createMockRouteParams({ id: 'p1' }))
    expect(res.status).toBe(403)
    expect(mockReopen).not.toHaveBeenCalled()
  })

  it('reopens the period and returns it on success', async () => {
    mockAuth()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReopen.mockResolvedValue({ id: 'p1', is_closed: false, closed_externally: false, locked_at: null } as any)
    const res = await POST(reopenRequest(), createMockRouteParams({ id: 'p1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe('p1')
    expect(body.data.is_closed).toBe(false)
    expect(mockReopen).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'p1')
  })

  it('maps a missing period to 404', async () => {
    mockAuth()
    mockReopen.mockRejectedValue(new Error('Fiscal period not found'))
    const res = await POST(reopenRequest(), createMockRouteParams({ id: 'p1' }))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_NOT_FOUND')
  })

  it('maps an open period to a 409', async () => {
    mockAuth()
    mockReopen.mockRejectedValue(new Error('Period is not closed'))
    const res = await POST(reopenRequest(), createMockRouteParams({ id: 'p1' }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_REOPEN_NOT_CLOSED')
  })

  it('maps a period closed by a year-end run to a 409', async () => {
    mockAuth()
    mockReopen.mockRejectedValue(
      new Error('Period was closed with a year-end run in Accounted and cannot be reopened here'),
    )
    const res = await POST(reopenRequest(), createMockRouteParams({ id: 'p1' }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_REOPEN_NOT_EXTERNAL')
  })
})
