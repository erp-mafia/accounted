import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/core/bookkeeping/period-service', () => ({
  lockPeriod: vi.fn(),
}))

import { requireAuth } from '@/lib/auth/require-auth'
import { lockPeriod } from '@/lib/core/bookkeeping/period-service'
import { POST } from '../route'

function lockRequest(): Request {
  return createMockRequest('/api/bookkeeping/fiscal-periods/p1/lock', { method: 'POST' })
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
})

describe('POST /api/bookkeeping/fiscal-periods/[id]/lock', () => {
  it('locks the period and returns it on success', async () => {
    mockAuth()
    ;(lockPeriod as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'p1', locked_at: '2026-06-15T00:00:00Z' })
    const res = await POST(lockRequest(), createMockRouteParams({ id: 'p1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe('p1')
  })

  // Regression: an unbooked-transactions failure must surface as a clear 400,
  // not a generic 500. lockPeriod throws a plain Error (no code) with the
  // Swedish count message; the route maps it to PERIOD_HAS_UNBOOKED_TRANSACTIONS.
  it('maps the unbooked-transactions error to a 400, not a 500', async () => {
    mockAuth()
    ;(lockPeriod as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Kan inte låsa period: 3 affärstransaktion(er) saknar bokföring. Bokför alla transaktioner innan perioden låses.'),
    )
    const res = await POST(lockRequest(), createMockRouteParams({ id: 'p1' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_HAS_UNBOOKED_TRANSACTIONS')
  })

  it('maps an already-locked period to a 409', async () => {
    mockAuth()
    ;(lockPeriod as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Period is already locked'))
    const res = await POST(lockRequest(), createMockRouteParams({ id: 'p1' }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_LOCK_ALREADY_LOCKED')
  })

  it('maps a missing period to a 404', async () => {
    mockAuth()
    ;(lockPeriod as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Fiscal period not found'))
    const res = await POST(lockRequest(), createMockRouteParams({ id: 'p1' }))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_NOT_FOUND')
  })
})
